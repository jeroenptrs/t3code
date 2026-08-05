import {
  isScheduledAutomationProviderEligible,
  type ScheduledAutomationDefinition,
  ScheduledAutomationInternalError,
  ScheduledAutomationValidationError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";

type ValidationError = ScheduledAutomationValidationError | ScheduledAutomationInternalError;

export interface ScheduledAutomationValidationShape {
  readonly validateLiveDefinition: (
    definition: ScheduledAutomationDefinition,
  ) => Effect.Effect<void, ValidationError>;
}

export class ScheduledAutomationValidation extends Context.Service<
  ScheduledAutomationValidation,
  ScheduledAutomationValidationShape
>()("t3/scheduledAutomation/ScheduledAutomationValidation") {}

function validationError(
  field: ScheduledAutomationValidationError["field"],
  message: string,
): ScheduledAutomationValidationError {
  return new ScheduledAutomationValidationError({ field, message });
}

const internalError = (operation: string, cause: unknown) =>
  Effect.logError(`Scheduled automation ${operation} failed.`, {
    errorTag:
      typeof cause === "object" && cause !== null && "_tag" in cause
        ? String(cause._tag)
        : typeof cause,
  }).pipe(
    Effect.andThen(
      new ScheduledAutomationInternalError({
        message: `Scheduled automation ${operation} failed.`,
      }),
    ),
  );

export const makeScheduledAutomationValidation = Effect.gen(function* () {
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const git = yield* GitWorkflow.GitWorkflowService;

  const validateLiveDefinition = Effect.fn("ScheduledAutomationValidation.validateLiveDefinition")(
    function* (definition: ScheduledAutomationDefinition) {
      const project = yield* projections
        .getProjectShellById(definition.projectId)
        .pipe(Effect.catch((cause) => internalError("project validation", cause)));
      if (Option.isNone(project)) {
        return yield* validationError("projectId", "The selected project is unavailable.");
      }

      const snapshots = yield* providers.getProviders;
      const provider = snapshots.find(
        (candidate) => candidate.instanceId === definition.modelSelection.instanceId,
      );
      if (provider === undefined || !isScheduledAutomationProviderEligible(provider)) {
        return yield* validationError(
          "modelSelection",
          "The selected provider instance is unavailable.",
        );
      }
      const model = provider.models.find(
        (candidate) => candidate.slug === definition.modelSelection.model,
      );
      if (model === undefined) {
        return yield* validationError("modelSelection", "The selected model is unavailable.");
      }

      const descriptors = model.capabilities?.optionDescriptors ?? [];
      const selections = definition.modelSelection.options ?? [];
      const seen = new Set<string>();
      for (const selection of selections) {
        if (seen.has(selection.id)) {
          return yield* validationError(
            "modelSelection",
            `Model option ${selection.id} is selected more than once.`,
          );
        }
        seen.add(selection.id);
        const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
        if (descriptor === undefined) {
          return yield* validationError(
            "modelSelection",
            `Model option ${selection.id} is unsupported.`,
          );
        }
        if (descriptor.type === "boolean" && typeof selection.value !== "boolean") {
          return yield* validationError(
            "modelSelection",
            `Model option ${selection.id} requires a boolean value.`,
          );
        }
        if (
          descriptor.type === "select" &&
          (typeof selection.value !== "string" ||
            !descriptor.options.some((choice) => choice.id === selection.value))
        ) {
          return yield* validationError(
            "modelSelection",
            `Model option ${selection.id} has an unsupported value.`,
          );
        }
      }

      if (definition.worktreePolicy.kind !== "new-worktree") return;
      const worktreePolicy = definition.worktreePolicy;
      let cursor: number | undefined;
      let found = false;
      do {
        const page = yield* git
          .listRefs({
            cwd: project.value.workspaceRoot,
            query: worktreePolicy.baseBranch,
            includeMatchingRemoteRefs: true,
            ...(cursor === undefined ? { refresh: true } : { cursor }),
            limit: 100,
          })
          .pipe(
            Effect.mapError(() =>
              validationError(
                "worktreePolicy.baseBranch",
                "The selected Git base ref could not be validated.",
              ),
            ),
          );
        if (!page.isRepo) {
          return yield* validationError(
            "worktreePolicy",
            "New worktrees require a Git-backed project.",
          );
        }
        found = page.refs.some((ref) => ref.name === worktreePolicy.baseBranch);
        cursor = page.nextCursor ?? undefined;
      } while (!found && cursor !== undefined);
      if (!found) {
        return yield* validationError(
          "worktreePolicy.baseBranch",
          "The selected Git base ref is unavailable.",
        );
      }
    },
  );

  return ScheduledAutomationValidation.of({ validateLiveDefinition });
});

export const layer = Layer.effect(ScheduledAutomationValidation, makeScheduledAutomationValidation);
