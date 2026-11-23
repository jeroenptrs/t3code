/**
 * Fork-only work item helpers for `FactoryService`: the messages the Foreman reads, and a role's
 * binding laid over a delegation. Plain functions; the ledger itself is in the service.
 */
import type {
  FactoryEffectiveBinding,
  FactoryName,
  FactoryRepository,
  FactoryRoleName,
  OrchestratorMcpDelegateTaskInput,
  WorkItemGateDecision,
  WorkItemId,
  WorkItemSource,
  WorkItemStage,
} from "@t3tools/contracts";

/** The work item as the Foreman's user message. */
export function renderWorkItemMessage(input: {
  readonly workItemId: WorkItemId;
  readonly factoryName: FactoryName;
  readonly title: string;
  readonly source: WorkItemSource;
  readonly repositories: ReadonlyArray<FactoryRepository>;
}): string {
  const { source } = input;
  const repositories =
    input.repositories.length === 0
      ? "The project covers no repository yet."
      : `Repositories the project covers. Name the one a child works in by name; the server picks its checkout:\n${input.repositories
          .map((repository) => `- ${repository.name}`)
          .join("\n")}`;
  const from =
    source.kind === "manual"
      ? "a person's request"
      : source.kind === "trigger"
        ? `trigger ${source.title} (${source.event.source})`
        : `scheduled task ${source.scheduledTaskId}`;
  return `Work item ${input.workItemId} for the ${input.factoryName} factory, from ${from}.

Title: ${input.title}

${source.text.trim()}

${repositories}

Delegate each task with t3_factory_delegate, naming the role. Hold the item for a person with t3_work_item_gate, and end it with t3_work_item_advance.`;
}

/** The follow-up the Foreman gets once a person answers its gate. */
export function renderGateAnswerMessage(input: {
  readonly workItemId: WorkItemId;
  readonly question: string;
  readonly decision: WorkItemGateDecision;
  readonly note: string;
  readonly stage: WorkItemStage;
}): string {
  const note = input.note.trim();
  const next =
    input.decision === "approved"
      ? input.stage === "done"
        ? "The item is done. Hand back your report."
        : "Carry on from there."
      : `The item is ${input.stage}. Stop work on it and hand back a short report.`;
  return `The person ${input.decision} the gate on work item ${input.workItemId}.

Question: ${input.question.trim()}
${note === "" ? "They left no note." : `Their note: ${note}`}

${next}`;
}

/** What the Foreman gets once a person drops its item. */
export function renderDropMessage(workItemId: WorkItemId): string {
  return `A person dropped work item ${workItemId}. Stop work on it and hand back a short report.`;
}

/**
 * The delegation with the role's isolation, modes, and model in place of the call's, and the note
 * the item's log keeps. A null model leaves the call's target as it is.
 */
export function bindDelegation(
  role: FactoryRoleName,
  delegation: OrchestratorMcpDelegateTaskInput,
  binding: FactoryEffectiveBinding,
): { readonly delegation: OrchestratorMcpDelegateTaskInput; readonly note: string } {
  const applied = [
    `isolation ${binding.isolation}`,
    `runtime mode ${binding.runtimeMode}`,
    `interaction mode ${binding.interactionMode}`,
  ];
  const replaced: Array<string> = [];
  if (delegation.isolation !== undefined && delegation.isolation !== binding.isolation) {
    replaced.push(`isolation ${delegation.isolation}`);
  }
  if (delegation.runtimeMode !== undefined && delegation.runtimeMode !== binding.runtimeMode) {
    replaced.push(`runtime mode ${delegation.runtimeMode}`);
  }
  if (
    delegation.interactionMode !== undefined &&
    delegation.interactionMode !== binding.interactionMode
  ) {
    replaced.push(`interaction mode ${delegation.interactionMode}`);
  }
  let target = delegation.target;
  const model = binding.model;
  if (model !== null) {
    applied.push(`model ${model.instanceId}/${model.model}`);
    const { driverKind, ...requested } = delegation.target ?? {};
    if (
      driverKind !== undefined ||
      (requested.providerInstanceId !== undefined &&
        requested.providerInstanceId !== model.instanceId) ||
      (requested.model !== undefined && requested.model !== model.model)
    ) {
      replaced.push(
        `model ${requested.providerInstanceId ?? driverKind ?? model.instanceId}/${requested.model ?? "default"}`,
      );
    }
    // Empty options clear what the parent would pass on, so the model's defaults apply.
    target = {
      ...requested,
      providerInstanceId: model.instanceId,
      model: model.model,
      options: model.options ?? [],
    };
  }
  return {
    delegation: {
      ...delegation,
      isolation: binding.isolation,
      runtimeMode: binding.runtimeMode,
      interactionMode: binding.interactionMode,
      ...(target === undefined ? {} : { target }),
    },
    note: `Applied the ${role} role's binding to a delegated task: ${applied.join(", ")}.${
      replaced.length === 0 ? "" : ` It replaced the call's ${replaced.join(", ")}.`
    }`,
  };
}
