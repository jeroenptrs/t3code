import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isThreadWorking,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "@t3tools/client-runtime/state/thread-inbox";
import {
  effectiveSnoozed,
  snoozeWakeLabel,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  resolveSettledThreadTimestamp,
  sortPinnedThreadsByOrderKey,
  sortSettledThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { statusColors } from "../../components/theme";

// The home list's partition and row status, following apps/mobile/src/features/threads/
// threadListV2.ts with the working shelf on and without search, reordering, or pending tasks.

export const SETTLED_INITIAL_COUNT = 10;
export const SETTLED_PAGE_COUNT = 25;

export type ThreadListStatus =
  | "approval"
  | "input"
  | "request"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

export function resolveThreadListStatus(
  thread: Pick<
    EnvironmentThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "pendingGuestMessageCount"
    | "runtime"
    | "blockedOnThreadWait"
  >,
): ThreadListStatus {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") return "approval";
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") return "input";
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return "request";
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) {
    return "waiting";
  }
  if (
    thread.runtime !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") return "waiting";
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}

function threadHasUnseenCompletion(
  thread: Pick<EnvironmentThreadShell, "latestRun" | "lastVisitedAt">,
): boolean {
  const completedAtMs = Date.parse(thread.latestRun?.completedAt ?? "");
  if (Number.isNaN(completedAtMs) || !thread.lastVisitedAt) return false;
  const lastVisitedAtMs = Date.parse(thread.lastVisitedAt);
  return Number.isNaN(lastVisitedAtMs) || completedAtMs > lastVisitedAtMs;
}

function resolveWokeAt(thread: EnvironmentThreadShell, now: string): string | null {
  // Older servers cannot persist an acknowledgement.
  if (thread.lastVisitedAt === undefined || thread.settledOverride === "settled") return null;
  const wokeAt = threadWokeAt(thread, { now });
  const wokeAtMs = Date.parse(wokeAt ?? "");
  const lastVisitedAtMs = Date.parse(thread.lastVisitedAt ?? "");
  return !Number.isNaN(wokeAtMs) && (Number.isNaN(lastVisitedAtMs) || lastVisitedAtMs < wokeAtMs)
    ? wokeAt
    : null;
}

export interface ThreadStatusChip {
  readonly label: string;
  readonly tone: keyof typeof statusColors;
}

const STATUS_CHIPS: Partial<Record<ThreadListStatus, ThreadStatusChip>> = {
  approval: { label: "Approval", tone: "approval" },
  input: { label: "Input", tone: "input" },
  request: { label: "Request", tone: "request" },
  working: { label: "Working", tone: "working" },
  waiting: { label: "Waiting", tone: "waiting" },
  failed: { label: "Failed", tone: "failed" },
  limited: { label: "Limited", tone: "limited" },
};

// Shared objects, so a rebuilt list hands memoized rows the same chip.
const GOAL_CHIP: ThreadStatusChip = { label: "Goal", tone: "working" };
const WOKE_CHIP: ThreadStatusChip = { label: "Woke", tone: "approval" };
const DONE_CHIP: ThreadStatusChip = { label: "Done", tone: "done" };

/** The chip a card row shows, as mobile's row picks it; null shows the time instead. */
export function resolveThreadStatusChip(
  thread: EnvironmentThreadShell,
  wokeAt: string | null,
): ThreadStatusChip | null {
  const status = resolveThreadListStatus(thread);
  if (status === "ready" && wokeAt !== null) return WOKE_CHIP;
  if (status === "working" && thread.goal?.status === "active") return GOAL_CHIP;
  return STATUS_CHIPS[status] ?? (threadHasUnseenCompletion(thread) ? DONE_CHIP : null);
}

export function relativeTime(iso: string, nowMs: number): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return "<1m";
  const minutes = Math.floor(Math.max(0, nowMs - timestamp) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export type ThreadSection = "active" | "working" | "snoozed" | "settled";

export const SECTION_LABELS: Record<ThreadSection, string> = {
  active: "Active",
  working: "Working",
  snoozed: "Snoozed",
  settled: "Settled",
};

export type ThreadListEntry =
  | {
      readonly type: "header";
      readonly key: string;
      readonly section: ThreadSection;
      readonly count: number;
      readonly expanded: boolean;
    }
  | {
      readonly type: "thread";
      readonly key: string;
      readonly section: ThreadSection;
      readonly thread: EnvironmentThreadShell;
      readonly chip: ThreadStatusChip | null;
      /** Relative time, or the wake time of a snoozed thread; empty when a chip shows. */
      readonly timeLabel: string;
      readonly pinned: boolean;
    }
  | { readonly type: "more"; readonly key: "more"; readonly hiddenCount: number };

export interface ThreadSectionsInput {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }> | null;
  readonly now: string;
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly expanded: Readonly<Record<"working" | "snoozed" | "settled", boolean>>;
  readonly settledLimit: number;
  readonly isWorking?: (thread: EnvironmentThreadShell) => boolean;
  readonly inboxReturnAt?: (thread: EnvironmentThreadShell) => number | undefined;
  /** Whether a settled row is loaded far enough to list; older settled rows load in pages. */
  readonly isListedSettled?: (thread: EnvironmentThreadShell) => boolean;
  /** Settled threads in scope that this client has not loaded. */
  readonly unloadedSettledCount?: number;
}

export interface ThreadSections {
  readonly entries: ReadonlyArray<ThreadListEntry>;
  /** The settled rows the shelf may list, before its limit; pages load until it is full. */
  readonly listedSettledThreads: ReadonlyArray<EnvironmentThreadShell>;
}

export function buildThreadSections(input: ThreadSectionsInput): ThreadSections {
  const { now } = input;
  const nowMs = Date.parse(now);
  const projectKeys = input.projectRefs
    ? new Set(input.projectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`))
    : null;
  const isWorking = input.isWorking ?? isThreadWorking;
  const pinned: EnvironmentThreadShell[] = [];
  const active: EnvironmentThreadShell[] = [];
  const working: EnvironmentThreadShell[] = [];
  const snoozed: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  for (const thread of input.threads) {
    if (
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      thread.lineage.relationshipToParent === "subagent" ||
      (input.environmentId !== null && thread.environmentId !== input.environmentId) ||
      (projectKeys !== null && !projectKeys.has(`${thread.environmentId}:${thread.projectId}`))
    ) {
      continue;
    }
    if (input.snoozeEnvironmentIds.has(thread.environmentId) && effectiveSnoozed(thread, { now })) {
      snoozed.push(thread);
    } else if (
      input.settlementEnvironmentIds.has(thread.environmentId) &&
      thread.settledOverride === "settled"
    ) {
      settled.push(thread);
    } else if (thread.pinnedAt != null) {
      pinned.push(thread);
    } else if (isWorking(thread)) {
      working.push(thread);
    } else {
      active.push(thread);
    }
  }

  const orderedSettled = sortSettledThreads(settled);
  const listedSettled =
    input.isListedSettled === undefined
      ? orderedSettled
      : orderedSettled.filter(input.isListedSettled);
  const settledTotal = orderedSettled.length + (input.unloadedSettledCount ?? 0);
  const pagedSettled = listedSettled.slice(0, input.settledLimit);

  const entries: ThreadListEntry[] = [];
  const card = (thread: EnvironmentThreadShell, section: ThreadSection, isPinned: boolean) => {
    const chip = resolveThreadStatusChip(thread, resolveWokeAt(thread, now));
    entries.push({
      type: "thread",
      key: `${section}:${thread.environmentId}:${thread.id}`,
      section,
      thread,
      chip,
      timeLabel:
        chip === null
          ? relativeTime(thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt, nowMs)
          : "",
      pinned: isPinned,
    });
  };
  const header = (section: ThreadSection, count: number, expanded: boolean) =>
    entries.push({ type: "header", key: `header:${section}`, section, count, expanded });

  const activeThreads = [
    ...sortPinnedThreadsByOrderKey(pinned),
    ...sortInboxThreadsByReturn(active, input.inboxReturnAt),
  ];
  if (activeThreads.length > 0) {
    header("active", activeThreads.length, true);
    for (const thread of activeThreads) card(thread, "active", thread.pinnedAt != null);
  }
  if (working.length > 0) {
    header("working", working.length, input.expanded.working);
    if (input.expanded.working) {
      for (const thread of sortWorkingThreadsBySend(working)) card(thread, "working", false);
    }
  }
  if (snoozed.length > 0) {
    header("snoozed", snoozed.length, input.expanded.snoozed);
    if (input.expanded.snoozed) {
      const ordered = [...snoozed].sort(
        (left, right) =>
          (Date.parse(left.snoozedUntil ?? "") || 0) - (Date.parse(right.snoozedUntil ?? "") || 0),
      );
      for (const thread of ordered) {
        entries.push({
          type: "thread",
          key: `snoozed:${thread.environmentId}:${thread.id}`,
          section: "snoozed",
          thread,
          chip: null,
          timeLabel: thread.snoozedUntil ? snoozeWakeLabel(thread.snoozedUntil, { now }) : "",
          pinned: false,
        });
      }
    }
  }
  if (settledTotal > 0) {
    header("settled", settledTotal, input.expanded.settled);
    if (input.expanded.settled) {
      for (const thread of pagedSettled) {
        entries.push({
          type: "thread",
          key: `settled:${thread.environmentId}:${thread.id}`,
          section: "settled",
          thread,
          chip: null,
          timeLabel: relativeTime(
            resolveSettledThreadTimestamp(thread) ?? thread.updatedAt ?? thread.createdAt,
            nowMs,
          ),
          pinned: false,
        });
      }
      const hiddenCount = settledTotal - pagedSettled.length;
      if (hiddenCount > 0) entries.push({ type: "more", key: "more", hiddenCount });
    }
  }
  return { entries, listedSettledThreads: listedSettled };
}
