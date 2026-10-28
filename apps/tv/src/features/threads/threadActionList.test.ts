import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveThreadActions,
  threadActionState,
  type ThreadActionCapabilities,
  type ThreadActionState,
} from "./threadActionList";

const NOW = "2026-06-02T12:00:00.000Z";
const ALL: ThreadActionCapabilities = { settlement: true, snooze: true, pinning: true };
const ACTIVE: ThreadActionState = {
  archived: false,
  snoozed: false,
  settled: false,
  pinned: false,
  snoozable: true,
};

function shell(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  const providerInstanceId = ProviderInstanceId.make("codex");
  const at = DateTime.makeUnsafe("2026-06-02T10:00:00.000Z");
  const raw: OrchestrationV2ThreadShell = {
    id: ThreadId.make("thread"),
    projectId: ProjectId.make("app"),
    title: "thread",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "mobile",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  };
  return { ...presentThreadShell(EnvironmentId.make("home"), raw), ...overrides };
}

describe("deriveThreadActions", () => {
  it("offers settle, snooze, pin, and archive for an active thread", () => {
    expect(deriveThreadActions(ACTIVE, ALL)).toEqual(["settle", "snooze", "pin", "archive"]);
  });

  it("offers unpin for a pinned thread", () => {
    expect(deriveThreadActions({ ...ACTIVE, pinned: true }, ALL)).toEqual([
      "settle",
      "snooze",
      "unpin",
      "archive",
    ]);
  });

  it("leaves snooze out while the thread cannot be snoozed", () => {
    expect(deriveThreadActions({ ...ACTIVE, snoozable: false }, ALL)).toEqual([
      "settle",
      "pin",
      "archive",
    ]);
  });

  it("offers unsettle for a settled thread, without snooze", () => {
    expect(deriveThreadActions({ ...ACTIVE, settled: true }, ALL)).toEqual([
      "unsettle",
      "pin",
      "archive",
    ]);
  });

  it("offers unsnooze and archive for a snoozed thread, as mobile's snoozed menu does", () => {
    expect(deriveThreadActions({ ...ACTIVE, snoozed: true, settled: true }, ALL)).toEqual([
      "unsnooze",
      "archive",
    ]);
  });

  it("offers only unarchive for an archived thread", () => {
    expect(deriveThreadActions({ ...ACTIVE, archived: true, pinned: true }, ALL)).toEqual([
      "unarchive",
    ]);
  });

  it("drops what the server cannot do", () => {
    const none = { settlement: false, snooze: false, pinning: false };
    expect(deriveThreadActions(ACTIVE, none)).toEqual(["archive"]);
    expect(deriveThreadActions({ ...ACTIVE, snoozed: true }, none)).toEqual(["archive"]);
    expect(deriveThreadActions(ACTIVE, { ...ALL, snooze: false })).toEqual([
      "settle",
      "pin",
      "archive",
    ]);
    expect(deriveThreadActions({ ...ACTIVE, settled: true }, { ...none, pinning: true })).toEqual([
      "archive",
      "pin",
    ]);
  });
});

describe("threadActionState", () => {
  it("reads an idle thread as active and snoozable", () => {
    expect(threadActionState(shell(), NOW)).toEqual(ACTIVE);
  });

  it("reads a future snooze as snoozed and a past one as awake", () => {
    expect(
      threadActionState(shell({ snoozedUntil: "2026-06-02T13:00:00.000Z" }), NOW).snoozed,
    ).toBe(true);
    expect(
      threadActionState(shell({ snoozedUntil: "2026-06-02T11:00:00.000Z" }), NOW).snoozed,
    ).toBe(false);
  });

  it("does not offer snooze while an approval waits", () => {
    expect(threadActionState(shell({ hasPendingApprovals: true }), NOW).snoozable).toBe(false);
  });

  it("reads settled, pinned, and archived", () => {
    const state = threadActionState(
      shell({
        settledOverride: "settled",
        pinnedAt: "2026-06-01T00:00:00.000Z",
        archivedAt: "2026-06-02T11:00:00.000Z",
      }),
      NOW,
    );
    expect(state).toMatchObject({ settled: true, pinned: true, archived: true });
  });
});
