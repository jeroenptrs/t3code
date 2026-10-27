import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { ThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import type {
  ThreadRunSummary,
  ThreadStructureRuntime,
} from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as ExpoCrypto from "expo-crypto";
import { AsyncResult } from "effect/reactivity";

import { tvAtomRegistry } from "../../state/atom-registry";
import { threadCommands } from "./state";

export type ThreadDispatchMode = "start" | "auto" | "queue";

/**
 * How mobile's composer dispatches a follow-up (use-thread-composer-state.ts), with its default
 * "steer" follow-up behavior: while workspace setup runs it queues; while a turn runs that can
 * take steering input it sends "auto", which steers the turn or, if the turn just ended, starts
 * one; otherwise it starts a turn, which the server holds as the next turn of a busy thread.
 */
export function resolveThreadDispatchMode(input: {
  readonly runtime: ThreadStructureRuntime | null;
  readonly activityRun: ThreadRunSummary | null;
  readonly queueWorkflow: ThreadQueueWorkflowState | null;
}): ThreadDispatchMode {
  const setupRunning = [input.activityRun?.status, input.runtime?.status].some(
    (status) => status === "preparing" || status === "starting",
  );
  if (setupRunning) return "queue";
  if (threadRuntimeIsActive(input.runtime) && input.queueWorkflow?.canPromoteToSteer === true) {
    return "auto";
  }
  return "start";
}

/**
 * Sends `text` as the next user message through client-runtime's thread startTurn command, the
 * command mobile's outbox delivers queued messages with, using the thread's current model,
 * runtime mode, and interaction mode. Resolves to an error message, or null once accepted.
 */
export async function sendThreadMessage(input: {
  readonly environmentId: EnvironmentId;
  readonly thread: Pick<
    OrchestrationV2ThreadProjection["thread"],
    "id" | "modelSelection" | "runtimeMode" | "interactionMode"
  >;
  readonly text: string;
  readonly dispatchMode: ThreadDispatchMode;
}): Promise<string | null> {
  const result = await runAtomCommand(
    tvAtomRegistry,
    threadCommands.startTurn,
    {
      environmentId: input.environmentId,
      input: {
        commandId: CommandId.make(ExpoCrypto.randomUUID()),
        creationSource: "mobile",
        threadId: input.thread.id,
        message: {
          messageId: MessageId.make(ExpoCrypto.randomUUID()),
          role: "user",
          text: input.text,
          attachments: [],
        },
        modelSelection: input.thread.modelSelection,
        titleSeed: deriveThreadTitleSeed({ text: input.text, attachments: [] }),
        runtimeMode: input.thread.runtimeMode,
        interactionMode: input.thread.interactionMode,
        createdAt: new Date().toISOString(),
        dispatchMode: input.dispatchMode,
      },
    },
    { reportFailure: false },
  );
  if (AsyncResult.isSuccess(result)) return null;
  const error = Cause.squash(result.cause);
  return error instanceof Error ? error.message : "The message could not be sent.";
}
