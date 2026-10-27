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
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type ProviderInteractionMode,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as ExpoCrypto from "expo-crypto";
import { AsyncResult } from "effect/reactivity";

import { tvAtomRegistry } from "../../state/atom-registry";
import { threadCommands } from "./state";

export type ThreadDispatchMode = "start" | "auto" | "queue";

type VisibleTurnItem = OrchestrationV2ThreadProjection["visibleTurnItems"][number];

const isCompactCommand = (item: VisibleTurnItem["item"]): boolean =>
  item.type === "user_message" &&
  item.text.trim().toLowerCase() === "/compact" &&
  item.attachments.length === 0;

/**
 * Whether the active turn is compacting, as mobile's composer works it out
 * (use-thread-composer-state.ts), without the outbox check: the TV has no outbox.
 */
export function threadIsCompacting(input: {
  readonly runtime: ThreadStructureRuntime | null;
  readonly visibleItems: ReadonlyArray<VisibleTurnItem>;
}): boolean {
  const activeRunId = input.runtime?.activeRunId;
  if (!activeRunId || !threadRuntimeIsActive(input.runtime)) return false;
  const inRun = input.visibleItems.filter(({ item }) => item.runId === activeRunId);
  if (inRun.some(({ item }) => item.type === "compaction" && item.status === "running")) {
    return true;
  }
  if (!inRun.some(({ item }) => isCompactCommand(item))) return false;
  return !inRun.some(
    ({ item }) =>
      item.type === "compaction" &&
      (item.status === "completed" ||
        item.status === "failed" ||
        item.status === "interrupted" ||
        item.status === "cancelled"),
  );
}

/**
 * Mobile's follow-up dispatch (use-thread-composer-state.ts) with "steer" behavior: queue during
 * workspace setup; "auto" while a turn runs that can take steering input (a compacting turn
 * cannot); otherwise start a turn, which the server holds behind a busy thread's current one.
 */
export function resolveThreadDispatchMode(input: {
  readonly runtime: ThreadStructureRuntime | null;
  readonly activityRun: ThreadRunSummary | null;
  readonly queueWorkflow: ThreadQueueWorkflowState | null;
  readonly isCompacting: boolean;
}): ThreadDispatchMode {
  const setupRunning = [input.activityRun?.status, input.runtime?.status].some(
    (status) => status === "preparing" || status === "starting",
  );
  if (setupRunning) return "queue";
  if (
    threadRuntimeIsActive(input.runtime) &&
    input.queueWorkflow?.canPromoteToSteer === true &&
    !input.isCompacting
  ) {
    return "auto";
  }
  return "start";
}

/**
 * The interaction mode to send, as mobile's resolveProviderInteractionMode
 * (apps/mobile/src/state/legacy-plan-mode.ts): providers that hide the interaction mode toggle
 * always get the default mode.
 */
export function resolveProviderInteractionMode(
  provider: Pick<ServerProvider, "showInteractionModeToggle"> | null | undefined,
  interactionMode: ProviderInteractionMode | null | undefined,
): ProviderInteractionMode {
  return provider?.showInteractionModeToggle === false
    ? DEFAULT_PROVIDER_INTERACTION_MODE
    : (interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE);
}

/**
 * Sends `text` as the next user message through client-runtime's thread startTurn command, the
 * command mobile's outbox delivers queued messages with, using the thread's current model,
 * runtime mode, and interaction mode
 * (reset to the default when the thread's provider hides the toggle). Resolves to an error message, or null once accepted.
 */
export async function sendThreadMessage(input: {
  readonly environmentId: EnvironmentId;
  readonly thread: Pick<
    OrchestrationV2ThreadProjection["thread"],
    "id" | "modelSelection" | "runtimeMode" | "interactionMode"
  >;
  readonly text: string;
  readonly dispatchMode: ThreadDispatchMode;
  readonly providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "showInteractionModeToggle">
  >;
}): Promise<string | null> {
  const provider = input.providers.find(
    (candidate) => candidate.instanceId === input.thread.modelSelection.instanceId,
  );
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
        interactionMode: resolveProviderInteractionMode(provider, input.thread.interactionMode),
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
