import {
  EnvironmentId,
  FactoryId,
  ThreadId,
  WorkItemId,
  type WorkItemSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createNeedsYouSelector,
  needsYouRows,
  type NeedsYouShell,
} from "./FactoryOverviewTab.logic";

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
    ["an item that has not failed", item({ stage: "implement" }), [shell()], 0],
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
