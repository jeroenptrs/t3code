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
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { pullRequestColors, statusColors } from "../../components/theme";

// The sidebar's partition and row status, following apps/mobile/src/features/threads/
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
  /** Which live duration follows the label: time working, or time since the run ended. */
  readonly duration: "working" | "waiting" | null;
}

const STATUS_CHIPS: Partial<Record<ThreadListStatus, ThreadStatusChip>> = {
  approval: { label: "Approval", tone: "approval", duration: null },
  input: { label: "Input", tone: "input", duration: null },
  request: { label: "Request", tone: "request", duration: null },
  working: { label: "Working", tone: "working", duration: "working" },
  waiting: { label: "Waiting", tone: "waiting", duration: "waiting" },
  failed: { label: "Failed", tone: "failed", duration: null },
  limited: { label: "Limited", tone: "limited", duration: null },
};

// Shared objects, so a rebuilt list hands memoized rows the same chip.
const GOAL_CHIP: ThreadStatusChip = { label: "Goal", tone: "working", duration: "working" };
const WOKE_CHIP: ThreadStatusChip = { label: "Woke", tone: "approval", duration: null };
const DONE_CHIP: ThreadStatusChip = { label: "Done", tone: "done", duration: null };

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

export interface ThreadPullRequestBadge {
  readonly number: number;
  readonly tone: keyof typeof pullRequestColors;
}

/** The pull request a row shows: the thread's current link, else the branch's; muted until known. */
export function threadPullRequestBadge(
  thread: Pick<EnvironmentThreadShell, "pullRequests" | "linkedPullRequest" | "branchPullRequest">,
): ThreadPullRequestBadge | null {
  const link = resolveThreadCurrentPullRequestLink(thread.pullRequests);
  if (link !== null) {
    const snapshot = link.snapshot;
    return {
      number: link.number,
      tone: snapshot === null || snapshot.isDraft ? "pending" : snapshot.state,
    };
  }
  const fallback = thread.linkedPullRequest ?? thread.branchPullRequest;
  return fallback ? { number: fallback.number, tone: "pending" } : null;
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

/** Pinned and active rows lead without a header; the shelves follow under theirs. */
export type ThreadSection = "active" | ThreadShelf;
export type ThreadShelf = "working" | "snoozed" | "settled";

export const SHELF_LABELS: Record<ThreadShelf, string> = {
  working: "Working",
  snoozed: "Snoozed",
  settled: "Settled",
};

/** Mobile's shelf header: the bare label while open, the count only once collapsed. */
export function shelfHeaderLabel(shelf: ThreadShelf, count: number, expanded: boolean): string {
  return expanded ? SHELF_LABELS[shelf] : `${SHELF_LABELS[shelf]} (${count})`;
}

export type ThreadListEntry =
  | {
      readonly type: "header";
      readonly key: string;
      readonly section: ThreadShelf;
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
  readonly expanded: Readonly<Record<ThreadShelf, boolean>>;
  readonly settledLimit: number;
  /** `environmentId:threadId` of the open thread, which a collapsed shelf still lists. */
  readonly selectedThreadKey?: string | null;
  /** Threads with messages waiting to send, which stay out of Settled until they go. */
  readonly queuedThreadKeys?: ReadonlySet<string>;
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

function threadKey(thread: EnvironmentThreadShell): string {
  return `${thread.environmentId}:${thread.id}`;
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
      thread.settledOverride === "settled" &&
      input.queuedThreadKeys?.has(threadKey(thread)) !== true
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
  const limitedSettled = listedSettled.slice(0, input.settledLimit);
  const selectedKey = input.selectedThreadKey ?? null;
  const isSelected = (thread: EnvironmentThreadShell) => threadKey(thread) === selectedKey;
  // A selected thread past the page still lists, as mobile's shelf keeps it.
  const selectedSettled = limitedSettled.some(isSelected)
    ? undefined
    : orderedSettled.find(isSelected);
  const pagedSettled =
    selectedSettled === undefined ? limitedSettled : [...limitedSettled, selectedSettled];
  /** A collapsed shelf lists only the selected thread, so the open thread never vanishes. */
  const shown = <T extends EnvironmentThreadShell>(threads: ReadonlyArray<T>, expanded: boolean) =>
    expanded ? threads : threads.filter(isSelected);

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
  const header = (section: ThreadShelf, count: number, expanded: boolean) =>
    entries.push({ type: "header", key: `header:${section}`, section, count, expanded });

  for (const thread of sortPinnedThreadsByOrderKey(pinned)) card(thread, "active", true);
  for (const thread of sortInboxThreadsByReturn(active, input.inboxReturnAt)) {
    card(thread, "active", false);
  }
  if (working.length > 0) {
    header("working", working.length, input.expanded.working);
    for (const thread of shown(sortWorkingThreadsBySend(working), input.expanded.working)) {
      card(thread, "working", false);
    }
  }
  if (snoozed.length > 0) {
    header("snoozed", snoozed.length, input.expanded.snoozed);
    const ordered = [...snoozed].sort(
      (left, right) =>
        (Date.parse(left.snoozedUntil ?? "") || 0) - (Date.parse(right.snoozedUntil ?? "") || 0),
    );
    for (const thread of shown(ordered, input.expanded.snoozed)) {
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
  if (settledTotal > 0) {
    header("settled", settledTotal, input.expanded.settled);
    for (const thread of shown(pagedSettled, input.expanded.settled)) {
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
    const hiddenCount = Math.max(0, settledTotal - pagedSettled.length);
    if (input.expanded.settled && hiddenCount > 0) {
      entries.push({ type: "more", key: "more", hiddenCount });
    }
  }
  return { entries, listedSettledThreads: listedSettled };
}

/** A thread row's place in the flattened list, captured before an action may move it. */
export interface ThreadRowPlace {
  readonly threadKey: string;
  readonly section: ThreadSection;
  readonly index: number;
}

export function captureThreadRowPlace(
  entries: ReadonlyArray<ThreadListEntry>,
  threadKey: string,
): ThreadRowPlace | null {
  const index = entries.findIndex(
    (entry) =>
      entry.type === "thread" && `${entry.thread.environmentId}:${entry.thread.id}` === threadKey,
  );
  const entry = entries[index];
  return entry?.type === "thread" ? { threadKey, section: entry.section, index } : null;
}

export type RowAfterMove =
  | { readonly moved: false }
  /** `thread` is null when no thread row is left to take the place. */
  | { readonly moved: true; readonly thread: EnvironmentThreadShell | null };

/**
 * The thread row that took a moved row's place: the first at or after its old index once the
 * moved row is left out, else the nearest before it. Not moved while the row keeps its section.
 */
export function resolveRowAfterMove(
  entries: ReadonlyArray<ThreadListEntry>,
  place: ThreadRowPlace,
): RowAfterMove {
  const isMoved = (entry: ThreadListEntry) =>
    entry.type === "thread" &&
    `${entry.thread.environmentId}:${entry.thread.id}` === place.threadKey;
  const current = entries.find(isMoved);
  if (current?.type === "thread" && current.section === place.section) return { moved: false };
  const rest = entries.filter((entry) => !isMoved(entry));
  for (let index = place.index; index < rest.length; index++) {
    const entry = rest[index]!;
    if (entry.type === "thread") return { moved: true, thread: entry.thread };
  }
  for (let index = Math.min(place.index, rest.length) - 1; index >= 0; index--) {
    const entry = rest[index]!;
    if (entry.type === "thread") return { moved: true, thread: entry.thread };
  }
  return { moved: true, thread: null };
}
