import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  resolveProjectProviderInstanceEnabled,
  ThreadId,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerConfig,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as ExpoCrypto from "expo-crypto";
import { AsyncResult } from "effect/reactivity";

import { tvAtomRegistry } from "../../state/atom-registry";
import { resolveProviderInteractionMode } from "./sendThreadMessage";
import { threadCommands } from "./state";

type Provider = ServerConfig["providers"][number];

export interface NewThreadDefaults {
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  /** "Provider · Model", or null without a model. */
  readonly modelLabel: string | null;
}

function usableProvider(
  config: ServerConfig,
  provider: Provider | undefined,
  projectId: ProjectId,
): provider is Provider {
  if (provider === undefined || !provider.installed || provider.auth.status === "unauthenticated") {
    return false;
  }
  if (provider.driver === "antigravity" && provider.availability === "unavailable") return false;
  return config.settings
    ? resolveProjectProviderInstanceEnabled(config.settings, projectId, provider.instanceId)
    : provider.enabled;
}

/**
 * The model and runtime mode mobile's new task starts with when nothing was picked
 * (apps/mobile/src/lib/modelOptions.ts resolveNewTaskModelSelection): the project's default model
 * when usable, else the first provider's default model, else the first shown model. Without t3.json
 * and without mobile's sticky last pick, which the TV does not keep.
 */
export function resolveNewThreadDefaults(
  config: ServerConfig | null,
  project: Pick<EnvironmentProject, "id" | "defaultModelSelection" | "defaultThreadEnvMode">,
): NewThreadDefaults {
  const settings = resolveProjectSettings(
    config?.settings ?? DEFAULT_SERVER_SETTINGS,
    project.id,
    project,
  ).settings;
  const runtimeMode = settings.defaultRuntimeMode;
  if (config === null) return { modelSelection: null, runtimeMode, modelLabel: null };
  const providers = config.providers.filter((provider) =>
    usableProvider(config, provider, project.id),
  );
  const preferred = settings.defaultModelSelection;
  const preferredProvider = providers.find(
    (provider) => provider.instanceId === preferred?.instanceId,
  );
  const preferredModel = preferredProvider?.models.find((model) => model.slug === preferred?.model);
  const pick =
    preferred && preferredProvider && preferredModel?.isLegacy !== true
      ? { provider: preferredProvider, selection: preferred }
      : (() => {
          const all = providers.flatMap((provider) => {
            const hidden = new Set(
              config.settings?.providerModelPreferences?.[provider.instanceId]?.hiddenModels ?? [],
            );
            return provider.models
              .filter((model) => model.isCustom || !hidden.has(model.slug))
              .map((model) => ({ provider, model }));
          });
          const found = all.find((entry) => entry.model.isDefault === true) ?? all[0];
          return found
            ? {
                provider: found.provider,
                selection: { instanceId: found.provider.instanceId, model: found.model.slug },
              }
            : null;
        })();
  if (pick === null) return { modelSelection: null, runtimeMode, modelLabel: null };
  const modelName =
    pick.provider.models.find((model) => model.slug === pick.selection.model)?.name ??
    pick.selection.model;
  const providerName = pick.provider.displayName || pick.provider.instanceId;
  return {
    modelSelection: pick.selection,
    runtimeMode,
    modelLabel: `${providerName} · ${modelName}`,
  };
}

/**
 * The startTurn input that creates a thread in the project's checkout and sends its first
 * message, as mobile's outbox delivers a new task in local mode
 * (apps/mobile/src/lib/projectThreadStartTurn.ts buildProjectThreadStartTurnInput).
 */
export function buildNewThreadStartTurnInput(input: {
  readonly projectId: ProjectId;
  readonly threadId: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly createdAt: string;
  readonly text: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}) {
  const title = deriveThreadTitleSeed({ text: input.text, attachments: [] });
  return {
    commandId: CommandId.make(input.commandId),
    creationSource: "mobile" as const,
    threadId: ThreadId.make(input.threadId),
    message: {
      messageId: MessageId.make(input.messageId),
      role: "user" as const,
      text: input.text,
      attachments: [],
    },
    modelSelection: input.modelSelection,
    titleSeed: title,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    bootstrap: {
      createThread: {
        projectId: input.projectId,
        title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: null,
        worktreePath: null,
        createdAt: input.createdAt,
      },
    },
    createdAt: input.createdAt,
  };
}

/** Creates the thread and sends `text` as its first message. Resolves to its id, or an error. */
export async function startNewThread(input: {
  readonly project: EnvironmentProject;
  readonly text: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly providers: ReadonlyArray<Provider>;
}): Promise<{ readonly threadId: ThreadId } | { readonly error: string }> {
  const threadId = ExpoCrypto.randomUUID();
  const provider = input.providers.find(
    (candidate) => candidate.instanceId === input.modelSelection.instanceId,
  );
  const result = await runAtomCommand(
    tvAtomRegistry,
    threadCommands.startTurn,
    {
      environmentId: input.project.environmentId,
      input: buildNewThreadStartTurnInput({
        projectId: input.project.id,
        threadId,
        commandId: ExpoCrypto.randomUUID(),
        messageId: ExpoCrypto.randomUUID(),
        createdAt: new Date().toISOString(),
        text: input.text,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: resolveProviderInteractionMode(provider, null),
      }),
    },
    { reportFailure: false },
  );
  if (AsyncResult.isSuccess(result)) return { threadId: ThreadId.make(threadId) };
  const error = Cause.squash(result.cause);
  return { error: error instanceof Error ? error.message : "The thread could not be started." };
}
