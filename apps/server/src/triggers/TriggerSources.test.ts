import { assert, it } from "@effect/vitest";
import type { JiraIssueSummary, ThreadPullRequestSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TriggerSources from "./TriggerSources.ts";

const SITE = "acme.atlassian.net";

const issue = (overrides: Partial<JiraIssueSummary> = {}): JiraIssueSummary => ({
  site: SITE,
  key: "PROJ-1",
  url: `https://${SITE}/browse/PROJ-1`,
  summary: "Fix login",
  status: "To Do",
  statusCategory: "todo",
  issueType: "Bug",
  parentKey: null,
  priority: null,
  assignee: null,
  sprints: [],
  storyPoints: null,
  updated: null,
  labels: [],
  ...overrides,
});

const snapshot = (
  overrides: Partial<ThreadPullRequestSnapshot> = {},
): ThreadPullRequestSnapshot => ({
  state: "open",
  title: "Add login",
  headBranch: "feature/login",
  baseBranch: "main",
  isDraft: false,
  updatedAt: "2026-11-05T09:00:00.000Z",
  syncedAt: "2026-11-05T09:00:00.000Z",
  checksState: "pending",
  ...overrides,
});

const gitlab = {
  host: "gitlab.acme.dev",
  repository: "group/app",
  number: 42,
  url: "https://gitlab.acme.dev/group/app/-/merge_requests/42",
};
const github = {
  host: "github.com",
  repository: "acme/app",
  number: 7,
  url: "https://github.com/acme/app/pull/7",
};

/** A fresh service over the shared database, as after a restart. */
const withSources = <A, E>(
  body: (sources: TriggerSources.TriggerSources["Service"]) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    return yield* body(yield* TriggerSources.TriggerSources);
  }).pipe(Effect.provide(Layer.fresh(TriggerSources.layer)));

const collect = (sources: TriggerSources.TriggerSources["Service"], count: number) =>
  sources.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.forkScoped({ startImmediately: true }),
  );

it.effect("seeds Jira issues silently, then raises their changes, across restarts", () =>
  Effect.gen(function* () {
    yield* withSources((sources) =>
      Effect.gen(function* () {
        const events = yield* collect(sources, 1);
        yield* sources.observeJiraIssues(SITE, [issue(), issue({ key: "PROJ-2" })]);
        yield* sources.observeJiraIssues(SITE, [issue({ status: "In Progress" })]);
        const [event] = yield* Fiber.join(events);
        assert.equal(event?.type, "issue.status_changed");
        assert.deepInclude(event?.payload, { key: "PROJ-1", previousStatus: "To Do" });
      }),
    );
    yield* withSources((sources) =>
      Effect.gen(function* () {
        const events = yield* collect(sources, 1);
        yield* sources.observeJiraIssues(SITE, [issue({ status: "In Progress" })]);
        yield* sources.observeJiraIssues(SITE, [issue({ key: "PROJ-2", labels: ["agent"] })]);
        const [event] = yield* Fiber.join(events);
        assert.equal(event?.type, "issue.labels_changed");
        assert.deepInclude(event?.payload, { key: "PROJ-2", addedLabels: ["agent"] });
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("raises opened for a new GitLab merge request and ignores other hosts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* withSources((sources) =>
      Effect.gen(function* () {
        const events = yield* collect(sources, 2);
        yield* sources.observePullRequest(github, snapshot());
        yield* sources.observePullRequest(gitlab, snapshot());
        yield* sources.observePullRequest(
          gitlab,
          snapshot({ syncedAt: "2026-11-05T09:05:00.000Z" }),
        );
        yield* sources.observePullRequest(gitlab, snapshot({ checksState: "failing" }));
        const collected = yield* Fiber.join(events);
        assert.deepEqual(
          collected.map((event) => [event.type, event.payload.type]),
          [
            ["merge_request.opened", "merge_request.opened"],
            ["pipeline.failed", "pipeline.failed"],
          ],
        );
      }),
    );
    yield* withSources((sources) =>
      Effect.gen(function* () {
        const events = yield* collect(sources, 1);
        yield* sources.observePullRequest(gitlab, snapshot({ state: "merged" }));
        const [event] = yield* Fiber.join(events);
        assert.equal(event?.type, "merge_request.merged");
        assert.deepInclude(event?.payload, { previousState: "open", number: "42" });
      }),
    );
    const rows = yield* sql<{ source: string; key: string }>`
      SELECT source, key FROM fork_trigger_observations ORDER BY key
    `;
    assert.deepEqual(rows, [{ source: "gitlab", key: "gitlab.acme.dev\u0000group/app\u000042" }]);
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);
