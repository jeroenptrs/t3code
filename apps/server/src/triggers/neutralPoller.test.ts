import { assert, it } from "@effect/vitest";
import {
  AuthUserId,
  type IssueListEntry,
  IssueTrackerKind,
  ProjectId,
  ProviderInstanceId,
  type ScheduledTask,
  ScheduledTaskId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as IssueService from "../issue/IssueService.ts";
import { JiraActingUser } from "../jira/JiraActingUser.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as NeutralPoller from "./neutralPoller.ts";
import * as TriggerSources from "./TriggerSources.ts";

const projectId = ProjectId.make("project-api");

const task = (schedule: ScheduledTask["schedule"]): ScheduledTask => ({
  id: ScheduledTaskId.make("task:issues"),
  title: "New bugs",
  prompt: "Triage {{event.title}}.",
  enabled: true,
  schedule,
  projectId,
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
});

const jiraIssue: IssueListEntry = {
  tracker: IssueTrackerKind.make("jira"),
  host: "acme.atlassian.net",
  scope: "PROJ",
  key: "PROJ-1",
  displayKey: "PROJ-1",
  title: "Fix login",
  url: "https://acme.atlassian.net/browse/PROJ-1",
  author: null,
  state: { category: "open", name: "To Do" },
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  closedAt: null,
  assignees: [],
  labels: [{ name: "bug", color: null }],
  commentCount: 0,
  projectId,
  projectTitle: "api",
};

const run = (
  schedule: ScheduledTask["schedule"],
  listed: {
    readonly entries: ReadonlyArray<IssueListEntry>;
    readonly errors: ReadonlyArray<{ readonly message: string }>;
  },
) =>
  Effect.gen(function* () {
    const readAs: Array<AuthUserId | null> = [];
    const observed: Array<{ readonly scope: string; readonly keys: ReadonlyArray<string> }> = [];
    const layer = Layer.mergeAll(
      Layer.mock(IssueService.IssueService)({
        list: (input) =>
          Effect.gen(function* () {
            readAs.push(yield* JiraActingUser);
            assert.deepStrictEqual(
              { projectId: input.projectId, state: input.state, labels: input.labels },
              { projectId, state: "all", labels: ["agent", "bug"] },
            );
            return {
              viewers: {},
              trackers: [],
              entries: listed.entries,
              errors: listed.errors.map((error) => ({
                projectId,
                projectTitle: "api",
                ...error,
              })),
              nextCursors: {},
            } as never;
          }),
      }),
      Layer.mock(PullRequestService.PullRequestService)({}),
      Layer.mock(TriggerSources.TriggerSources)({
        observeNeutral: (input) =>
          Effect.sync(() => {
            observed.push({
              scope: input.scope,
              keys: input.items.map((item) => ("key" in item ? item.key : String(item.number))),
            });
          }),
      }),
    );
    const outcome = yield* Effect.gen(function* () {
      const poller = yield* NeutralPoller.make;
      // A signed-in person's context around the poll must not reach Jira.
      return yield* poller
        .poll(task(schedule))
        .pipe(Effect.provideService(JiraActingUser, AuthUserId.make("user-ada")), Effect.result);
    }).pipe(Effect.provide(layer));
    return { readAs, observed, outcome };
  });

const schedule = {
  type: "issues",
  everyMs: 900_000,
  labels: ["bug", "agent"],
} as const satisfies ScheduledTask["schedule"];

it.effect("polls issues as the service identity, never the person around it", () =>
  Effect.gen(function* () {
    const { readAs, observed, outcome } = yield* run(schedule, {
      entries: [jiraIssue],
      errors: [],
    });
    assert.isTrue(outcome._tag === "Success");
    assert.deepStrictEqual(readAs, [null]);
    assert.deepStrictEqual(observed, [
      { scope: JSON.stringify([projectId, null, ["agent", "bug"]]), keys: ["PROJ-1"] },
    ]);
  }),
);

it.effect("fails a poll that read nothing, and keeps what a partial read found", () =>
  Effect.gen(function* () {
    const failed = yield* run(schedule, { entries: [], errors: [{ message: "Jira is down." }] });
    assert.isTrue(failed.outcome._tag === "Failure");
    assert.lengthOf(failed.observed, 0);
    const partial = yield* run(schedule, {
      entries: [jiraIssue],
      errors: [{ message: "GitHub is down." }],
    });
    assert.isTrue(partial.outcome._tag === "Success");
    assert.lengthOf(partial.observed, 1);
  }),
);
