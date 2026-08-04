import {
  SCHEDULED_AUTOMATION_ABANDONED_CODE,
  ProviderInstanceId,
  isScheduledAutomationProviderEligible,
  type CommandId,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationProject,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ScheduledAutomation,
  type ScheduledAutomationCommand,
  type ScheduledAutomationDefinitionDraft,
  type ScheduledAutomationSchedule,
  type ScheduledAutomationValidationField,
  type ScheduledAutomationView,
  type ServerProvider,
} from "@t3tools/contracts";
import { nextScheduledAutomationOccurrence } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { newCommandId } from "../../lib/utils";

export interface AutomationProjectOption extends Pick<
  OrchestrationProject,
  "id" | "title" | "workspaceRoot" | "defaultModelSelection" | "repositoryIdentity"
> {
  readonly environmentId?: EnvironmentId;
}

export const CURRENT_WORKSPACE_DISCLOSURE =
  "Shared with you and other automations; changes are not isolated.";
export const NEW_WORKTREE_DISCLOSURE =
  "Isolated per run and eligible for server-configured retention cleanup after it is safe to remove.";
export const DELETE_AUTOMATION_DISCLOSURE =
  "This removes only the disabled automation definition. Prior threads, branches, and worktrees are not deleted.";
export const DISABLE_AUTOMATION_DISCLOSURE =
  "Disabling prevents future runs and does not interrupt the linked thread.";
export const ABANDON_AUTOMATION_DISCLOSURE =
  "This ends retry for the failed occurrence. Its linked thread, branch, and worktree are retained; future runs use a new occurrence.";
export const AUTOMATION_ID_ERROR =
  "Use 1–64 letters, numbers, dots, underscores, or dashes, beginning with a letter or number.";

export function isValidAutomationId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.trim());
}

export const EMPTY_AUTOMATION_DEFINITION: ScheduledAutomationDefinitionDraft = {
  name: "",
  prompt: "",
  projectId: "" as ScheduledAutomationDefinitionDraft["projectId"],
  modelSelection: {
    instanceId: ProviderInstanceId.make("t3code_no_provider"),
    model: "",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  worktreePolicy: { kind: "current" },
  setupScriptPolicy: "skip",
  schedule: {
    cron: "0 9 * * 1-5",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    misfirePolicy: "latest-only",
  },
};

export function liveModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection | null | undefined,
): ModelSelection | null {
  if (!selection) return null;
  const provider = providers.find(
    (candidate) =>
      candidate.instanceId === selection.instanceId &&
      isScheduledAutomationProviderEligible(candidate),
  );
  const model = provider?.models.find((candidate) => candidate.slug === selection.model);
  if (!provider || !model) return null;
  const options = normalizeProviderOptions(
    model.capabilities?.optionDescriptors ?? [],
    selection.options,
  );
  return {
    instanceId: selection.instanceId,
    model: selection.model,
    ...(options ? { options } : {}),
  };
}

export function defaultLiveModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  project?: Pick<OrchestrationProject, "defaultModelSelection"> | null,
): ModelSelection | null {
  const projectDefault = liveModelSelection(providers, project?.defaultModelSelection);
  if (projectDefault) return projectDefault;
  for (const provider of providers) {
    if (!isScheduledAutomationProviderEligible(provider)) {
      continue;
    }
    const model = provider.models.find((candidate) => candidate.isDefault) ?? provider.models[0];
    if (model) {
      const options = normalizeProviderOptions(
        model.capabilities?.optionDescriptors ?? [],
        undefined,
      );
      return {
        instanceId: provider.instanceId,
        model: model.slug,
        ...(options ? { options } : {}),
      };
    }
  }
  return null;
}

export function normalizeProviderOptions(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  current: ReadonlyArray<ProviderOptionSelection> | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  const currentById = new Map(current?.map((selection) => [selection.id, selection.value]));
  const selections = descriptors.flatMap((descriptor): ProviderOptionSelection[] => {
    const value = currentById.get(descriptor.id);
    if (descriptor.type === "boolean") {
      return [
        {
          id: descriptor.id,
          value: typeof value === "boolean" ? value : (descriptor.currentValue ?? false),
        },
      ];
    }
    const selected =
      typeof value === "string" && descriptor.options.some((option) => option.id === value)
        ? value
        : (descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id);
    return selected ? [{ id: descriptor.id, value: selected }] : [];
  });
  return selections.length > 0 ? selections : undefined;
}

export function changeAutomationProject(
  draft: ScheduledAutomationDefinitionDraft,
  project: AutomationProjectOption,
  providers: ReadonlyArray<ServerProvider>,
): ScheduledAutomationDefinitionDraft {
  const projectDefault = liveModelSelection(providers, project.defaultModelSelection);
  const currentSelection = liveModelSelection(providers, draft.modelSelection);
  return {
    ...draft,
    projectId: project.id,
    modelSelection: projectDefault ??
      currentSelection ?? {
        instanceId: ProviderInstanceId.make("t3code_no_provider"),
        model: "",
      },
    worktreePolicy:
      draft.worktreePolicy.kind === "new-worktree"
        ? { ...draft.worktreePolicy, baseBranch: "" }
        : draft.worktreePolicy,
  };
}

export function automationDraftFromRow(
  automation: ScheduledAutomation,
  providers?: ReadonlyArray<ServerProvider>,
): ScheduledAutomationDefinitionDraft {
  const normalizedSelection = providers
    ? liveModelSelection(providers, automation.modelSelection)
    : null;
  return {
    name: automation.name,
    prompt: automation.prompt,
    projectId: automation.projectId,
    modelSelection: normalizedSelection ?? automation.modelSelection,
    runtimeMode: automation.runtimeMode,
    interactionMode: automation.interactionMode,
    worktreePolicy: automation.worktreePolicy,
    setupScriptPolicy: automation.setupScriptPolicy,
    schedule: automation.schedule,
  };
}

export function buildAutomationSaveCommand(input: {
  readonly automationId: ScheduledAutomationCommand["automationId"];
  readonly definition: ScheduledAutomationDefinitionDraft;
  readonly existing?: ScheduledAutomation | null;
  readonly now: string;
  readonly commandId?: CommandId;
}): ScheduledAutomationCommand {
  const commandId = input.commandId ?? newCommandId();
  return input.existing
    ? {
        type: "scheduledAutomation.update",
        commandId,
        automationId: input.existing.id,
        expectedRevision: input.existing.revision,
        definition: input.definition,
        createdAt: input.now as ScheduledAutomation["updatedAt"],
      }
    : {
        type: "scheduledAutomation.create",
        commandId,
        automationId: input.automationId,
        definition: input.definition,
        createdAt: input.now as ScheduledAutomation["createdAt"],
      };
}

function selectionsEqual(left: ModelSelection, right: ModelSelection): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? []) === JSON.stringify(right.options ?? [])
  );
}

export function canSubmitAutomationDraft(input: {
  readonly automationId: string;
  readonly draft: ScheduledAutomationDefinitionDraft;
  readonly existing: ScheduledAutomation | null;
  readonly projectAvailable: boolean;
  readonly modelLive: boolean;
  readonly worktreeAvailable: boolean;
}): boolean {
  const preservesUnavailableProject =
    input.existing !== null &&
    !input.existing.enabled &&
    input.draft.projectId === input.existing.projectId;
  const preservesUnavailableModel =
    input.existing !== null &&
    !input.existing.enabled &&
    selectionsEqual(input.draft.modelSelection, input.existing.modelSelection);
  const preservesUnavailableWorktree =
    input.existing !== null &&
    !input.existing.enabled &&
    JSON.stringify(input.draft.worktreePolicy) === JSON.stringify(input.existing.worktreePolicy);
  return (
    isValidAutomationId(input.automationId) &&
    (input.projectAvailable || preservesUnavailableProject) &&
    (input.modelLive || preservesUnavailableModel) &&
    (input.draft.worktreePolicy.kind === "current" ||
      (input.draft.worktreePolicy.baseBranch.trim().length > 0 &&
        (input.worktreeAvailable || preservesUnavailableWorktree)))
  );
}

export function previewAutomationSchedule(
  schedule: ScheduledAutomationDefinitionDraft["schedule"],
  after: string,
): { readonly next: string | null; readonly error: string | null } {
  const result = nextScheduledAutomationOccurrence(schedule as ScheduledAutomationSchedule, after);
  return Result.isSuccess(result)
    ? { next: result.success, error: null }
    : { next: null, error: result.failure.message };
}

export function buildAutomationRevisionCommand(
  automation: ScheduledAutomation,
  action: "enable" | "disable" | "retry" | "abandon" | "delete",
  now: string,
): ScheduledAutomationCommand {
  const common = {
    commandId: newCommandId(),
    automationId: automation.id,
    expectedRevision: automation.revision,
    createdAt: now as ScheduledAutomation["updatedAt"],
  };
  if (action === "enable" || action === "disable") {
    return { type: "scheduledAutomation.enabled.set", ...common, enabled: action === "enable" };
  }
  if (action === "retry") return { type: "scheduledAutomation.retry-last", ...common };
  if (action === "abandon") {
    return { type: "scheduledAutomation.failed.abandon", ...common };
  }
  return { type: "scheduledAutomation.delete", ...common };
}

export const canDeleteAutomation = (automation: ScheduledAutomation): boolean =>
  !automation.enabled;

export const canRetryAutomation = (automation: ScheduledAutomation): boolean =>
  automation.lastOutcome?.kind === "failed" && automation.lastOutcome.retryable;

export const canAbandonAutomation = (automation: ScheduledAutomation): boolean =>
  !automation.enabled &&
  automation.lastOutcome?.kind === "failed" &&
  automation.lastOutcome.code !== SCHEDULED_AUTOMATION_ABANDONED_CODE;

export function applyAutomationConflictRows(
  views: ReadonlyArray<ScheduledAutomationView>,
  conflicts: ReadonlyMap<ScheduledAutomation["id"], ScheduledAutomation>,
): ReadonlyArray<ScheduledAutomationView> {
  return views.map((view) => {
    const current = conflicts.get(view.automation.id);
    return current && current.revision > view.automation.revision
      ? { ...view, automation: current }
      : view;
  });
}

export type AutomationCommandFailureState =
  | {
      readonly kind: "validation";
      readonly errors: Partial<Record<ScheduledAutomationValidationField, string>>;
      readonly shouldRetry: false;
    }
  | {
      readonly kind: "conflict";
      readonly current: ScheduledAutomation;
      readonly message: string;
      readonly shouldRetry: false;
    }
  | { readonly kind: "error"; readonly message: string; readonly shouldRetry: false };

export function reconcileAutomationCommandFailure(error: unknown): AutomationCommandFailureState {
  if (typeof error !== "object" || error === null || !("_tag" in error)) {
    return { kind: "error", message: "The automation request failed.", shouldRetry: false };
  }
  if (
    error._tag === "ScheduledAutomationValidationError" &&
    "field" in error &&
    "message" in error &&
    typeof error.field === "string" &&
    typeof error.message === "string"
  ) {
    return {
      kind: "validation",
      errors: { [error.field as ScheduledAutomationValidationField]: error.message },
      shouldRetry: false,
    };
  }
  if (error._tag === "ScheduledAutomationConflictError" && "current" in error) {
    const current = error.current as ScheduledAutomation;
    return {
      kind: "conflict",
      current,
      message: `“${current.name}” changed on another device. The server version is now revision ${current.revision}; review it before trying again.`,
      shouldRetry: false,
    };
  }
  const message =
    "message" in error && typeof error.message === "string"
      ? error.message
      : "The automation request failed.";
  return { kind: "error", message, shouldRetry: false };
}
