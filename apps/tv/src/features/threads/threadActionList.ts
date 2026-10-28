import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";

// Which actions mobile's row menu (apps/mobile/src/features/threads/thread-list-v2-items.tsx)
// offers for a thread's state.

export type ThreadActionId =
  | "settle"
  | "unsettle"
  | "snooze"
  | "unsnooze"
  | "pin"
  | "unpin"
  | "archive"
  | "unarchive";

export interface ThreadActionCapabilities {
  readonly settlement: boolean;
  readonly snooze: boolean;
  readonly pinning: boolean;
}

export interface ThreadActionState {
  readonly archived: boolean;
  readonly snoozed: boolean;
  readonly settled: boolean;
  readonly pinned: boolean;
  /** Snoozing is allowed now: nothing waits on the user and no turn is starting. */
  readonly snoozable: boolean;
}

export const THREAD_ACTION_LABELS: Record<ThreadActionId, string> = {
  settle: "Settle",
  unsettle: "Unsettle",
  snooze: "Snooze",
  unsnooze: "Unsnooze",
  pin: "Pin",
  unpin: "Unpin",
  archive: "Archive",
  unarchive: "Unarchive",
};

/** The actions mobile's row menu offers for a thread in this state, in its order. */
export function deriveThreadActions(
  state: ThreadActionState,
  capabilities: ThreadActionCapabilities,
): ReadonlyArray<ThreadActionId> {
  if (state.archived) return ["unarchive"];
  const pin: ReadonlyArray<ThreadActionId> = capabilities.pinning
    ? [state.pinned ? "unpin" : "pin"]
    : [];
  if (capabilities.snooze && state.snoozed) return ["unsnooze", "archive"];
  if (!capabilities.settlement) return ["archive", ...pin];
  if (state.settled) return ["unsettle", ...pin, "archive"];
  return [
    "settle",
    ...(capabilities.snooze && state.snoozable ? (["snooze"] as const) : []),
    ...pin,
    "archive",
  ];
}

export function threadActionState(thread: EnvironmentThreadShell, now: string): ThreadActionState {
  return {
    archived: thread.archivedAt !== null,
    snoozed: effectiveSnoozed(thread, { now }),
    settled: thread.settledOverride === "settled",
    pinned: thread.pinnedAt != null,
    snoozable: canSnooze(thread, { now }),
  };
}
