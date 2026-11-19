import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, FactoryId, ProjectId, ThreadId, type Trigger } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import {
  factoryListedThreads,
  factoryNameError,
  factoryTriggerSummary,
  settledShelfRows,
  showsFactoriesTab,
} from "./factories.logic";

const projectId = ProjectId.make("project-api");
const existing = [{ projectId, name: "nightly-triage" }];

describe("factoryNameError", () => {
  it.each([
    { name: "  ", expected: "Enter a name." },
    { name: "a".repeat(65), expected: "Use 64 characters or fewer." },
    { name: "Nightly", expected: "Use lowercase letters" },
    { name: "nightly--triage", expected: "Use lowercase letters" },
    { name: "-nightly", expected: "Use lowercase letters" },
    { name: "nightly triage", expected: "Use lowercase letters" },
    { name: "nightly-triage", expected: "This project already has a factory with this name." },
    { name: " release-2 ", expected: null },
  ])("returns $expected for $name", ({ name, expected }) => {
    const error = factoryNameError(name, existing, projectId);
    if (expected === null) expect(error).toBeNull();
    else expect(error).toContain(expected);
  });

  it("allows a name another project already uses", () => {
    expect(factoryNameError("nightly-triage", existing, ProjectId.make("project-web"))).toBeNull();
  });
});

describe("showsFactoriesTab", () => {
  const environmentId = EnvironmentId.make("environment-local");
  const factory = {
    id: FactoryId.make("factory:project-api:nightly-triage"),
    projectId,
    name: "nightly-triage",
    issueCount: 0,
    scheduledTaskIds: [],
    threadIds: [],
    attention: { gatesWaiting: 0, failedRuns: 0, questions: 0, total: 0 },
  };

  it.each([
    { label: "no environment answered", factories: null, canManage: true, expected: false },
    { label: "an operator with no factories", factories: [], canManage: false, expected: false },
    { label: "an administrator with no factories", factories: [], canManage: true, expected: true },
    { label: "an operator with a factory", factories: [factory], canManage: false, expected: true },
  ])("is $expected for $label", ({ factories, canManage, expected }) => {
    expect(showsFactoriesTab([{ environmentId, factories, canManage }])).toBe(expected);
  });
});

describe("factoryListedThreads", () => {
  it("lists runs and trigger threads, and leaves subagents and side chats to their run", () => {
    const environmentId = EnvironmentId.make("environment-local");
    const runId = ThreadId.make("thread-run");
    const thread = (id: string, overrides: Parameters<typeof makeThreadFixture>[0] = {}) =>
      makeThreadFixture({ id: ThreadId.make(id), environmentId, ...overrides });
    const run = thread("thread-run");
    const triggered = thread("thread-triggered");
    const implement = thread("thread-implement", {
      lineage: { rootThreadId: runId, parentThreadId: runId, relationshipToParent: "subagent" },
    });
    const sideChat = thread("thread-side-chat", {
      lineage: {
        rootThreadId: runId,
        parentThreadId: runId,
        relationshipToParent: null,
        sideChat: true,
      },
    });
    const archived = thread("thread-archived", { archivedAt: "2026-03-09T10:00:00.000Z" });
    const owned = new Map(
      [run, triggered, implement, sideChat, archived].map((entry) => [
        scopedThreadKey(scopeThreadRef(environmentId, entry.id)),
        entry,
      ]),
    );
    const factory = {
      threadIds: [run, triggered, implement, sideChat, archived, thread("thread-unloaded")].map(
        (entry) => entry.id,
      ),
    };

    expect(factoryListedThreads(environmentId, factory, owned, new Set())).toEqual([
      run,
      triggered,
    ]);
  });
});

describe("factoryTriggerSummary", () => {
  it("ends with where each run goes", () => {
    const thread = { type: "thread" } as Trigger["target"];
    expect(factoryTriggerSummary({ source: { kind: "manual" }, filters: [], target: thread })).toBe(
      "Manual → thread",
    );
    const workItem = {
      type: "work_item" as const,
      projectId,
      factoryId: FactoryId.make("factory:project-api:nightly-triage"),
    };
    expect(factoryTriggerSummary({ source: { kind: "jira" }, filters: [], target: workItem })).toBe(
      "Jira → nightly-triage",
    );
  });
});

describe("settledShelfRows", () => {
  const environmentId = EnvironmentId.make("environment-local");
  const threads = Array.from({ length: 5 }, (_, index) => ({
    environmentId,
    id: ThreadId.make(`thread-${index}`),
  }));
  const keyOf = (index: number) =>
    scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(`thread-${index}`)));

  it("shows the first threads up to the limit and counts the rest", () => {
    expect(settledShelfRows(threads, 2, null)).toEqual({ shown: threads.slice(0, 2), hidden: 3 });
    expect(settledShelfRows(threads, 5, null)).toEqual({ shown: threads, hidden: 0 });
  });

  it("keeps the open thread past the limit, and does not count it as hidden", () => {
    expect(settledShelfRows(threads, 2, keyOf(4))).toEqual({
      shown: [threads[0], threads[1], threads[4]],
      hidden: 2,
    });
    expect(settledShelfRows(threads, 2, keyOf(1)).hidden).toBe(3);
  });
});
