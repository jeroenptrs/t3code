import {
  EnvironmentId,
  FactoryId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkItemError,
  WorkItemId,
  WorkItemTransitionError,
  type Factory,
  type FactoryIssue,
  type FactoryRole,
  type WorkItemSummary,
} from "@t3tools/contracts";
import { mFallback } from "gt-i18n";
import { describe, expect, it } from "vite-plus/test";

import {
  canSaveDefinition,
  createNeedsYouSelector,
  factorySaveInput,
  gateAnswerError,
  gateAnswerInput,
  needsYouRows,
  roleEnabledChange,
  runningRoles,
  workItemFailureMessage,
  type NeedsYouShell,
  type RunningRoleShell,
} from "./factories.ts";

const environmentId = EnvironmentId.make("environment-local");
const runThread = ThreadId.make("factory-foreman:work-item:1");

const item = (overrides: Partial<WorkItemSummary>): WorkItemSummary => ({
  id: WorkItemId.make("work-item:1"),
  factoryId: FactoryId.make("factory:project-api:nightly"),
  title: "Fix the login redirect",
  source: { kind: "manual", text: "" },
  stage: "failed",
  gate: { state: "none" },
  foremanThreadId: runThread,
  foremanRunId: null,
  dispatchedAt: null,
  failureDismissedAt: null,
  failedByUser: false,
  threads: [],
  createdAt: "2026-11-18T10:00:00.000Z",
  updatedAt: "2026-11-18T10:00:00.000Z",
  ...overrides,
});

const shell = (overrides: Partial<NeedsYouShell> = {}): NeedsYouShell => ({
  environmentId,
  id: runThread,
  archivedAt: null,
  settledOverride: null,
  ...overrides,
});

const failures = (failed: WorkItemSummary, shells: ReadonlyArray<NeedsYouShell>) =>
  needsYouRows({ environmentId, waiting: [], failed: [failed], shells }).length;

describe("needsYouRows", () => {
  it.each([
    ["a failure on an open run thread", item({}), [shell()], 1],
    ["a failure whose run never started", item({ foremanThreadId: null }), [], 1],
    ["a failure a person caused", item({ failedByUser: true }), [shell()], 0],
    ["a dismissed failure", item({ failureDismissedAt: "2026-11-18T11:00:00.000Z" }), [shell()], 0],
    ["a failure on a settled thread", item({}), [shell({ settledOverride: "settled" })], 0],
    [
      "a failure on an archived thread",
      item({}),
      [shell({ archivedAt: "2026-11-18T11:00:00.000Z" })],
      0,
    ],
    ["a failure whose thread is gone", item({}), [], 0],
    [
      "a failure whose thread is in another environment",
      item({}),
      [shell({ environmentId: EnvironmentId.make("remote") })],
      0,
    ],
    ["an item that has not failed", item({ stage: "working" }), [shell()], 0],
  ] as const)("counts %s as %i", (_name, failed, shells, expected) => {
    expect(failures(failed, shells)).toBe(expected);
  });

  it("lists gates before failures", () => {
    const gate = item({ id: WorkItemId.make("work-item:2"), stage: "waiting" });
    expect(
      needsYouRows({ environmentId, waiting: [gate], failed: [item({})], shells: [shell()] }).map(
        (row) => [row.kind, row.item.id],
      ),
    ).toEqual([
      ["gate", "work-item:2"],
      ["failure", "work-item:1"],
    ]);
  });
});

describe("createNeedsYouSelector", () => {
  it("returns the same rows while a shell changes nothing they show", () => {
    const select = createNeedsYouSelector();
    const failed = [item({})];
    const first = select({ environmentId, waiting: [], failed, shells: [shell()] });
    expect(select({ environmentId, waiting: [], failed, shells: [shell()] })).toBe(first);
    expect(
      select({
        environmentId,
        waiting: [],
        failed,
        shells: [shell({ settledOverride: "settled" })],
      }),
    ).toEqual([]);
  });
});

const projectId = ProjectId.make("project-api");
const model = { instanceId: ProviderInstanceId.make("claude"), model: "claude-haiku-5-5" };

const review: FactoryRole = {
  role: "review",
  path: "roles/review.md",
  source: "file",
  fileBinding: { enabled: false, model, skills: ["review-checklist"], tools: ["Read"] },
  binding: {
    model,
    runtimeMode: "full-access",
    interactionMode: "default",
    isolation: "worktree",
    skills: ["review-checklist"],
    tools: ["Read"],
  },
  description: "",
  enabled: false,
  body: "Review against the task.",
  bodySource: "file",
  skills: [{ name: "review-checklist", source: "factory", description: "", replaces: null }],
};

const factory: Pick<Factory, "projectId" | "definition"> = {
  projectId,
  definition: {
    version: 2,
    name: "nightly-triage",
    roles: { review: "roles/review.md", implement: null },
  },
};

describe("roleEnabledChange", () => {
  it.each([
    [true, { model, skills: ["review-checklist"], tools: ["Read"] }],
    [false, { model, skills: ["review-checklist"], tools: ["Read"], enabled: false }],
  ] as const)("sets enabled %s and keeps the rest of the file", (enabled, binding) => {
    expect(roleEnabledChange(review, enabled)).toEqual({
      role: "review",
      file: { binding, body: "Review against the task." },
    });
  });
});

describe("factorySaveInput", () => {
  it("saves the definition as read, with its version and role order, plus one role change", () => {
    const change = roleEnabledChange(review, true);
    const input = factorySaveInput(factory, { roles: [change] });
    expect(input).toEqual({ projectId, definition: factory.definition, roles: [change] });
    expect(Object.keys(input.definition.roles)).toEqual(["review", "implement"]);
  });

  it("replaces only the definition fields a view owns", () => {
    expect(factorySaveInput(factory, { definition: { roles: {} } })).toEqual({
      projectId,
      definition: { ...factory.definition, roles: {} },
    });
  });
});

const issue = (role: string | null, field: string | null, code = "unknown_model"): FactoryIssue =>
  ({ code, role, field, message: "" }) as FactoryIssue;

describe("canSaveDefinition", () => {
  it("refuses saves over a factory.json that could not be read", () => {
    expect(canSaveDefinition({ issues: [issue(null, null, "invalid_definition")] })).toBe(false);
    expect(canSaveDefinition({ issues: [issue(null, "projects", "invalid_definition")] })).toBe(
      true,
    );
  });
});

describe("gateAnswerError", () => {
  it.each([
    { decision: "approved", note: "", expected: null },
    { decision: "rejected", note: "  ", expected: "Add a note to reject." },
    { decision: "rejected", note: "Out of scope", expected: null },
  ] as const)("$decision with note '$note'", ({ decision, note, expected }) => {
    expect(gateAnswerError(decision, note, mFallback)).toBe(expected);
  });

  it("sends the note trimmed", () => {
    const workItemId = WorkItemId.make("work-item:1");
    expect(gateAnswerInput(workItemId, "approved", "  go ahead \n")).toEqual({
      workItemId,
      decision: "approved",
      note: "go ahead",
    });
  });
});

describe("workItemFailureMessage", () => {
  it.each([
    {
      error: new WorkItemError({ code: "no_gate", message: "No gate holds this item." }),
      expected: "No gate holds this item.",
    },
    {
      error: new WorkItemTransitionError({
        workItemId: WorkItemId.make("work-item:1"),
        from: "done",
        to: "dropped",
      }),
      expected: "The item cannot move from done to dropped.",
    },
    { error: "socket closed", expected: "The answer could not be sent." },
  ])("shows $expected", ({ error, expected }) => {
    expect(workItemFailureMessage(error, "The answer could not be sent.", mFallback)).toBe(
      expected,
    );
  });
});

describe("runningRoles", () => {
  it("groups the item's running children by role, and leaves out finished and roleless ones", () => {
    const thread = (id: string) => ThreadId.make(id);
    const runtime = (status: "running" | "completed") => ({
      status,
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: null,
      lastError: null,
      updatedAt: "2026-11-18T10:00:00.000Z",
    });
    const shells: ReadonlyArray<RunningRoleShell> = [
      { environmentId, id: thread("t-api"), runtime: runtime("running") },
      { environmentId, id: thread("t-ui"), runtime: runtime("running") },
      { environmentId, id: thread("t-review"), runtime: runtime("completed") },
      { environmentId, id: thread("t-helper"), runtime: runtime("running") },
      // The same id in another environment is another thread.
      {
        environmentId: EnvironmentId.make("other"),
        id: thread("t-checks"),
        runtime: runtime("running"),
      },
    ];
    const working = item({
      stage: "working",
      threads: [
        { threadId: thread("t-api"), role: "implement" },
        { threadId: thread("t-review"), role: "review" },
        { threadId: thread("t-ui"), role: "implement" },
        { threadId: thread("t-helper"), role: null },
        { threadId: thread("t-checks"), role: "checks" },
      ],
    });
    expect(runningRoles(working, environmentId, shells)).toEqual([
      { role: "implement", threadIds: [thread("t-api"), thread("t-ui")] },
    ]);
  });
});
