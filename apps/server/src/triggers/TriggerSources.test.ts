import { assert, it } from "@effect/vitest";
import {
  type JiraIssueSummary,
  ScheduledTaskId,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import type { GitLabPipelineState } from "./gitlabTriggerSource.ts";
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

it.effect("seeds a Jira query's result set silently, then raises entered, left, and changes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const triggerId = ScheduledTaskId.make("task:query");
    const other = ScheduledTaskId.make("task:other-query");
    const poll = (
      sources: TriggerSources.TriggerSources["Service"],
      issues: ReadonlyArray<JiraIssueSummary>,
      input: {
        readonly triggerId?: ScheduledTaskId;
        readonly complete?: boolean;
        readonly start?: "changes" | "current";
        readonly fireCurrent?: boolean;
      } = {},
    ) =>
      sources.observeJiraQuery({
        triggerId: input.triggerId ?? triggerId,
        query: "project = PROJ",
        issues,
        watchedFields: new Set(["status", "labels", "assignee"]),
        complete: input.complete ?? true,
        start: input.start ?? "changes",
        fireCurrent: input.fireCurrent ?? false,
      });
    const observed = (id: ScheduledTaskId) =>
      sql<{ key: string }>`
        SELECT key FROM fork_trigger_observations
        WHERE source = 'jira_query' AND key LIKE ${`${id}%`} ORDER BY key
      `.pipe(Effect.map((rows) => rows.map((row) => row.key.split("\u0000").at(-1))));

    yield* withSources((sources) =>
      Effect.gen(function* () {
        const events = yield* collect(sources, 4);
        yield* poll(sources, [issue(), issue({ key: "PROJ-2" })]);
        // A trigger that starts on the current set raises entered for it on its first poll.
        yield* poll(sources, [issue({ key: "PROJ-9" })], { triggerId: other, start: "current" });
        yield* poll(sources, [issue({ key: "PROJ-9" })], { triggerId: other, start: "current" });
        yield* poll(sources, [issue({ status: "In Progress" }), issue({ key: "PROJ-3" })]);
        const collected = yield* Fiber.join(events);
        assert.deepEqual(
          collected.map((event) => [
            event.type,
            event.source === "jira_query" ? event.payload.key : null,
            event.triggerId,
          ]),
          [
            ["issue.entered", "PROJ-9", other],
            ["issue.status_changed", "PROJ-1", triggerId],
            ["issue.entered", "PROJ-3", triggerId],
            ["issue.left", "PROJ-2", triggerId],
          ],
        );
        assert.deepEqual(yield* observed(triggerId), ["", "PROJ-1", "PROJ-3"]);
        assert.deepEqual(yield* observed(other), ["", "PROJ-9"]);
      }),
    );
    yield* withSources((sources) =>
      Effect.gen(function* () {
        const events = yield* collect(sources, 1);
        // After a restart the same set raises nothing, and a truncated set raises no leaves.
        yield* poll(sources, [issue({ status: "In Progress" }), issue({ key: "PROJ-3" })]);
        yield* poll(sources, [issue({ status: "In Progress" })], { complete: false });
        yield* poll(sources, [issue({ status: "Done" }), issue({ key: "PROJ-3" })]);
        const [event] = yield* Fiber.join(events);
        assert.equal(event?.type, "issue.status_changed");
        assert.deepInclude(event?.payload, { key: "PROJ-1", previousStatus: "In Progress" });
        assert.deepEqual(yield* observed(triggerId), ["", "PROJ-1", "PROJ-3"]);
      }),
    );
    yield* withSources((sources) =>
      Effect.gen(function* () {
        // Firing the current set raises entered once per issue in it, beside the poll's own events.
        const events = yield* collect(sources, 4);
        const set = [issue({ status: "Done" }), issue({ key: "PROJ-3" }), issue({ key: "PROJ-4" })];
        yield* poll(sources, set, { fireCurrent: true });
        yield* poll(sources, set);
        yield* poll(sources, [issue({ key: "PROJ-9" })], { triggerId: other, fireCurrent: true });
        const collected = yield* Fiber.join(events);
        assert.deepEqual(
          collected
            .map(
              (event) => `${event.type} ${event.source === "jira_query" ? event.payload.key : ""}`,
            )
            .toSorted(),
          [
            "issue.entered PROJ-1",
            "issue.entered PROJ-3",
            "issue.entered PROJ-4",
            "issue.entered PROJ-9",
          ],
        );
        assert.deepEqual(yield* observed(triggerId), ["", "PROJ-1", "PROJ-3", "PROJ-4"]);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "records a GitLab projects poll's marker, raises opened and finished pipelines, forgets ended work",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-05T10:00:00.000Z"));
      const sql = yield* SqlClient.SqlClient;
      const triggerId = ScheduledTaskId.make("task:projects");
      const host = "gitlab.acme.dev";
      const mergeRequest = (
        number: number,
        overrides: Partial<ThreadPullRequestSnapshot> = {},
      ) => ({
        key: {
          host,
          repository: "acme/app",
          number,
          url: `https://${host}/acme/app/-/merge_requests/${number}`,
        },
        snapshot: snapshot({ headBranch: `feature/${number}`, checksState: null, ...overrides }),
      });
      const pipeline = (id: string, overrides: Partial<GitLabPipelineState> = {}) => ({
        id,
        repository: "acme/app",
        status: "running",
        ref: "main",
        url: `https://${host}/acme/app/-/pipelines/${id}`,
        updatedAt: "2026-11-05T09:00:00.000Z",
        ...overrides,
      });
      const poll = (
        sources: TriggerSources.TriggerSources["Service"],
        input: {
          readonly scope?: string;
          readonly mergeRequests?: ReadonlyArray<ReturnType<typeof mergeRequest>>;
          readonly pipelines?: ReadonlyArray<GitLabPipelineState>;
          readonly triggerId?: ScheduledTaskId;
          readonly start?: "changes" | "current";
          readonly fireCurrent?: boolean;
        },
      ) =>
        sources.observeGitLabProjects({
          triggerId: input.triggerId ?? triggerId,
          start: input.start ?? "current",
          fireCurrent: input.fireCurrent ?? false,
          host,
          marker: {
            scope: input.scope ?? '["gitlab.acme.dev",["acme/app"],null]',
            marks: { "merge_requests:acme/app": "2026-11-05T09:00:00.000Z" },
          },
          mergeRequests: input.mergeRequests ?? [],
          pipelines: input.pipelines ?? [],
        });
      const observed = () =>
        sql<{ key: string }>`
          SELECT key FROM fork_trigger_observations
          WHERE source = 'gitlab_projects' ORDER BY key
        `.pipe(Effect.map((rows) => rows.map((row) => row.key.split("\u0000").slice(2).join(" "))));
      const described = (event: { readonly type: string; readonly payload: object }) => [
        event.type,
        "number" in event.payload ? event.payload.number : null,
        "pipelineId" in event.payload ? event.payload.pipelineId : null,
      ];

      yield* withSources((sources) =>
        Effect.gen(function* () {
          assert.isNull(yield* sources.gitLabProjectsMarker(triggerId));
          const events = yield* collect(sources, 4);
          // Starting on the current set, the first poll raises opened for open merge requests and
          // no pipeline events.
          yield* poll(sources, {
            mergeRequests: [
              mergeRequest(42),
              mergeRequest(43, { state: "merged" }),
              mergeRequest(44),
            ],
            pipelines: [pipeline("901", { status: "success" }), pipeline("902")],
          });
          yield* poll(sources, {
            mergeRequests: [mergeRequest(42, { state: "merged" })],
            pipelines: [
              pipeline("901", { status: "success" }),
              pipeline("903", { status: "failed", ref: "refs/merge-requests/44/head" }),
            ],
          });
          const collected = yield* Fiber.join(events);
          assert.deepEqual(collected.map(described), [
            ["merge_request.opened", "42", null],
            ["merge_request.opened", "44", null],
            ["merge_request.merged", "42", null],
            // A merge request pipeline names its merge request through its ref.
            ["pipeline.finished", "44", "903"],
          ]);
        }),
      );
      yield* withSources((sources) =>
        Effect.gen(function* () {
          // A restart resumes from the stored marker.
          assert.deepEqual((yield* sources.gitLabProjectsMarker(triggerId))?.marks, {
            "merge_requests:acme/app": "2026-11-05T09:00:00.000Z",
          });
          const events = yield* collect(sources, 1);
          yield* poll(sources, { pipelines: [pipeline("902", { status: "canceled" })] });
          yield* poll(sources, { pipelines: [pipeline("902", { status: "canceled" })] });
          const [finished] = yield* Fiber.join(events);
          assert.deepEqual(described(finished!), ["pipeline.finished", "", "902"]);
          assert.equal(finished?.triggerId, triggerId);
        }),
      );
      // A branch pipeline names the open merge request from that branch.
      yield* withSources((sources) =>
        Effect.gen(function* () {
          const events = yield* collect(sources, 1);
          yield* poll(sources, {
            pipelines: [pipeline("904", { status: "failed", ref: "feature/44" })],
          });
          const [finished] = yield* Fiber.join(events);
          assert.deepInclude(finished?.payload, {
            number: "44",
            pipelineStatus: "failed",
            pipelineRef: "feature/44",
          });
        }),
      );
      assert.deepEqual(yield* observed(), [
        "",
        "acme/app 42",
        "acme/app 43",
        "acme/app 44",
        "acme/app pipeline 901",
        "acme/app pipeline 902",
        "acme/app pipeline 903",
        "acme/app pipeline 904",
      ]);

      // Thirty days on, merged and closed merge requests and finished pipelines are forgotten.
      yield* TestClock.adjust("31 days");
      yield* withSources((sources) => poll(sources, {}));
      assert.deepEqual(yield* observed(), ["", "acme/app 44"]);

      // A changed scope re-seeds silently and drops what the old scope saw.
      yield* withSources((sources) =>
        Effect.gen(function* () {
          const events = yield* collect(sources, 1);
          yield* poll(sources, { scope: "group", mergeRequests: [mergeRequest(45)] });
          yield* poll(sources, { scope: "group", mergeRequests: [mergeRequest(46)] });
          const [opened] = yield* Fiber.join(events);
          assert.deepEqual(described(opened!), ["merge_request.opened", "46", null]);
        }),
      );
      assert.deepEqual(yield* observed(), ["", "acme/app 45", "acme/app 46"]);

      // Starting on changes, the first poll records the open merge requests silently.
      yield* withSources((sources) =>
        Effect.gen(function* () {
          const changes = ScheduledTaskId.make("task:changes");
          const events = yield* collect(sources, 1);
          yield* poll(sources, {
            triggerId: changes,
            start: "changes",
            mergeRequests: [mergeRequest(50)],
          });
          yield* poll(sources, {
            triggerId: changes,
            start: "changes",
            mergeRequests: [mergeRequest(51)],
          });
          const [opened] = yield* Fiber.join(events);
          assert.deepEqual(described(opened!), ["merge_request.opened", "51", null]);
        }),
      );
      // Firing the current set raises opened once per open merge request, ended ones excluded.
      yield* withSources((sources) =>
        Effect.gen(function* () {
          const changes = ScheduledTaskId.make("task:changes");
          const events = yield* collect(sources, 4);
          const fire = {
            triggerId: changes,
            start: "changes",
            mergeRequests: [
              mergeRequest(50),
              mergeRequest(51),
              mergeRequest(52),
              mergeRequest(53, { state: "closed" }),
            ],
          } as const;
          yield* poll(sources, { ...fire, fireCurrent: true });
          yield* poll(sources, fire);
          yield* poll(sources, { ...fire, mergeRequests: [mergeRequest(54)] });
          const collected = yield* Fiber.join(events);
          assert.deepEqual(collected.slice(0, 3).map(described).toSorted(), [
            ["merge_request.opened", "50", null],
            ["merge_request.opened", "51", null],
            ["merge_request.opened", "52", null],
          ]);
          assert.deepEqual(described(collected[3]!), ["merge_request.opened", "54", null]);
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);
