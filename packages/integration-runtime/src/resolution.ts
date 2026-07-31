import {
  isProviderAvailable,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type ServerConfig,
} from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";
import * as Effect from "effect/Effect";

import { IngressFailure, type IngressRequest } from "./model.ts";

export interface ResolvedStandardIngressTarget {
  readonly project: OrchestrationProjectShell;
  readonly modelSelection: ModelSelection;
  readonly title: string;
  readonly runtimeMode: "full-access";
  readonly interactionMode: "default";
  readonly branch: null;
  readonly worktreePath: null;
  readonly environmentId: ServerConfig["environment"]["environmentId"];
}

const isUsableModelSelection = (
  selection: ModelSelection,
  providers: ServerConfig["providers"],
): boolean => {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (
    provider === undefined ||
    !provider.enabled ||
    !provider.installed ||
    !isProviderAvailable(provider) ||
    provider.status === "disabled" ||
    provider.status === "error" ||
    provider.auth.status === "unauthenticated"
  ) {
    return false;
  }
  const model = provider.models.find((candidate) => candidate.slug === selection.model);
  if (model === undefined) return false;
  const selections = selection.options ?? [];
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const seen = new Set<string>();
  return selections.every((selected) => {
    if (seen.has(selected.id)) return false;
    seen.add(selected.id);
    const descriptor = descriptors.find((candidate) => candidate.id === selected.id);
    if (descriptor === undefined) return false;
    return descriptor.type === "boolean"
      ? typeof selected.value === "boolean"
      : typeof selected.value === "string" &&
          descriptor.options.some((option) => option.id === selected.value);
  });
};

export const resolveStandardIngressTarget = Effect.fn(
  "integrationRuntime.resolveStandardIngressTarget",
)(function* (input: {
  readonly request: IngressRequest;
  readonly shell: OrchestrationShellSnapshot;
  readonly config: ServerConfig;
}) {
  const prompt = input.request.invocation.prompt.trim();
  if (prompt.length === 0) {
    return yield* Effect.fail(new IngressFailure("invalid_request", "A prompt is required."));
  }
  const project = input.shell.projects.find(
    (candidate) => candidate.id === input.request.target.projectId,
  );
  if (project === undefined) {
    return yield* Effect.fail(
      new IngressFailure("project_not_found", "The configured T3 project no longer exists."),
    );
  }
  const modelSelection = input.request.target.modelSelection ?? project.defaultModelSelection;
  if (modelSelection === null || !isUsableModelSelection(modelSelection, input.config.providers)) {
    return yield* Effect.fail(
      new IngressFailure(
        "model_unavailable",
        "No valid default model is configured for this T3 project.",
      ),
    );
  }

  return {
    project,
    modelSelection,
    title: truncate(prompt),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    environmentId: input.config.environment.environmentId,
  } satisfies ResolvedStandardIngressTarget;
});
