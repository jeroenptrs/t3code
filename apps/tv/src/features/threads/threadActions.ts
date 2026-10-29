import {
  runAtomCommand,
  type AtomCommand,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { tvAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells, serverEnvironment } from "../../state/environments";
import { threadCommands } from "./state";
import type { ThreadActionCapabilities, ThreadActionId } from "./threadActionList";
import { awaitEnvironmentScope } from "./vcs";

// Mobile's thread actions (apps/mobile/src/features/home/useThreadListActions.ts), without
// undo, rename, or delete.

export function readThreadActionCapabilities(
  environmentId: EnvironmentId,
): ThreadActionCapabilities & { readonly pinReorder: boolean } {
  const capabilities = tvAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))
    ?.environment.capabilities;
  return {
    settlement: capabilities?.threadSettlement === true,
    snooze: capabilities?.threadSnooze === true,
    pinning: capabilities?.threadPinning === true,
    pinReorder: capabilities?.threadPinReorder === true,
  };
}

const FAILURE_TITLES: Record<ThreadActionId, string> = {
  settle: "Could not settle thread",
  unsettle: "Could not unsettle thread",
  snooze: "Could not snooze thread",
  unsnooze: "Could not wake thread",
  pin: "Could not pin thread",
  unpin: "Could not unpin thread",
  archive: "Could not archive thread",
  unarchive: "Could not unarchive thread",
};

const inFlight = new Set<string>();

export interface ThreadActionEvent {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly action: ThreadActionId;
  readonly phase: "start" | "success" | "failure";
}

const listeners = new Set<(event: ThreadActionEvent) => void>();

/** Hears each dispatched action as it starts and ends, whichever surface ran it. */
export function subscribeThreadActions(listener: (event: ThreadActionEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const emit = (event: ThreadActionEvent) => {
  for (const listener of listeners) listener(event);
};

/**
 * Runs `action` with mobile's checks: the operate scope, the server capability, archive only
 * when no turn runs, snooze only when nothing waits. Resolves to a failure notice, or null.
 */
export async function runThreadAction(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly action: ThreadActionId;
  /** Required for snooze. */
  readonly snoozedUntil?: string;
}): Promise<string | null> {
  const { environmentId, threadId, action } = input;
  const title = FAILURE_TITLES[action];
  if (!(await awaitEnvironmentScope(environmentId, AuthOrchestrationOperateScope))) {
    return `${title}: this connection cannot change threads.`;
  }
  const capabilities = readThreadActionCapabilities(environmentId);
  const thread = tvAtomRegistry.get(
    environmentThreadShells.threadShellAtom({ environmentId, threadId }),
  );
  if ((action === "settle" || action === "unsettle") && !capabilities.settlement) {
    return `${title}: this environment's server does not support settling yet.`;
  }
  if ((action === "snooze" || action === "unsnooze") && !capabilities.snooze) {
    return `${title}: this environment's server does not support snoozing yet.`;
  }
  if ((action === "pin" || action === "unpin") && !capabilities.pinning) {
    return `${title}: this environment's server does not support pinning yet.`;
  }
  if (action === "archive" && thread !== null && !threadRuntimeCanArchive(thread.runtime)) {
    return `${title}: this thread is working. Interrupt it first, then try again.`;
  }
  if (action === "snooze") {
    if (thread !== null && !canSnooze(thread, { now: new Date().toISOString() })) {
      return thread.hasPendingApprovals ||
        thread.hasPendingUserInput ||
        thread.pendingSubagentRequest != null
        ? `${title}: this thread is waiting on you. Respond to the pending request first.`
        : `${title}: this thread is still starting a turn. Try again once it's running.`;
    }
    if (!input.snoozedUntil || !(Date.parse(input.snoozedUntil) > Date.now())) {
      return `${title}: that snooze time has passed. Choose another time.`;
    }
  }

  const key = `${environmentId}:${threadId}`;
  if (inFlight.has(key)) return null;
  inFlight.add(key);
  emit({ environmentId, threadId, action, phase: "start" });
  let succeeded = false;
  try {
    const result = await dispatch(input, capabilities.pinReorder);
    succeeded = AsyncResult.isSuccess(result);
    if (AsyncResult.isSuccess(result)) return null;
    const error = Cause.squash(result.cause);
    return error instanceof Error && error.message.trim().length > 0
      ? `${title}: ${error.message}`
      : `${title}.`;
  } finally {
    inFlight.delete(key);
    emit({ environmentId, threadId, action, phase: succeeded ? "success" : "failure" });
  }
}

function dispatch(
  input: Parameters<typeof runThreadAction>[0],
  pinReorder: boolean,
): Promise<AtomCommandResult<unknown, unknown>> {
  const { environmentId, threadId } = input;
  const run = <W, A, E>(command: AtomCommand<W, A, E>, value: W) =>
    runAtomCommand(tvAtomRegistry, command, value, { reportFailure: false });
  switch (input.action) {
    case "settle":
      return run(threadCommands.settle, { environmentId, input: { threadId } });
    case "unsettle":
      // "user" holds the thread active until real activity clears it, as mobile sends.
      return run(threadCommands.unsettle, { environmentId, input: { threadId, reason: "user" } });
    case "snooze":
      return run(threadCommands.snooze, {
        environmentId,
        input: { threadId, snoozedUntil: input.snoozedUntil! },
      });
    case "unsnooze":
      return run(threadCommands.unsnooze, { environmentId, input: { threadId, reason: "user" } });
    case "pin": {
      const orderKey = pinReorder ? firstPinOrderKey() : undefined;
      return run(threadCommands.pin, {
        environmentId,
        input: { threadId, ...(orderKey ? { orderKey } : {}) },
      });
    }
    case "unpin":
      return run(threadCommands.unpin, { environmentId, input: { threadId } });
    case "archive":
      return run(threadCommands.archive, { environmentId, input: { threadId } });
    case "unarchive":
      return run(threadCommands.unarchive, { environmentId, input: { threadId } });
  }
}

/** A key before every pinned thread's, so a new pin leads the list as on mobile. */
function firstPinOrderKey(): string | undefined {
  let firstKey: string | null = null;
  for (const shell of tvAtomRegistry.get(environmentThreadShells.threadShellsAtom)) {
    if (shell.pinnedAt == null || shell.pinOrderKey == null) continue;
    if (firstKey === null || shell.pinOrderKey < firstKey) firstKey = shell.pinOrderKey;
  }
  return pinOrderKeyBetween(null, firstKey) ?? undefined;
}
