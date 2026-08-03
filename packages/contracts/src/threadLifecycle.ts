import type { OrchestrationThreadShell } from "./orchestration.ts";

/**
 * Maximum time a user message can remain unadopted before it stops counting as
 * a queued turn start. Session adoption normally takes seconds; bounding this
 * state prevents stale shells from remaining active forever.
 */
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

/**
 * Returns whether the latest user message is fresh work that no turn has
 * adopted yet. This is shared by clients and server-owned background triggers
 * so overlap and settlement decisions use the same clock-skew-bounded truth.
 */
export function hasQueuedTurnStart(
  shell: Pick<OrchestrationThreadShell, "latestUserMessageAt" | "latestTurn" | "session">,
  options: { readonly now: string },
): boolean {
  if (shell.latestUserMessageAt == null) return false;
  if (shell.session?.status === "error") return false;

  const messageAt = Date.parse(shell.latestUserMessageAt);
  if (Number.isNaN(messageAt)) return false;
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(nowMs)) return false;
  if (Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;

  const turn = shell.latestTurn;
  if (turn === null) return true;
  return [turn.requestedAt, turn.startedAt, turn.completedAt].every(
    (candidate) => candidate == null || Date.parse(candidate) < messageAt,
  );
}
