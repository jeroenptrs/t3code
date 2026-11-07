/**
 * Fork-only work item helpers for `FactoryService`: the messages the Foreman reads, the role a
 * delegated task's child takes on an item, and that role's binding laid over the delegation. Plain
 * functions; the ledger itself is in the service.
 */
import type {
  FactoryEffectiveBinding,
  FactoryName,
  FactoryRoleName,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpTaskRole,
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
}): string {
  const { source } = input;
  const from =
    source.kind === "manual"
      ? "a person's request"
      : source.kind === "trigger"
        ? `trigger ${source.title} (${source.event.source})`
        : `scheduled task ${source.scheduledTaskId}`;
  return `Work item ${input.workItemId} for the ${input.factoryName} factory, from ${from}.

Title: ${input.title}

${source.text.trim()}

Advance this item with t3_work_item_advance as you route it, and hold it for a person with t3_work_item_gate.`;
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
      ? `The item is at ${input.stage} again. Carry on from there.`
      : `The item is ${input.stage}. Stop work on it and hand back a short report.`;
  return `The person ${input.decision} the gate on work item ${input.workItemId}.

Question: ${input.question.trim()}
${note === "" ? "They left no note." : `Their note: ${note}`}

${next}`;
}

/** The role a delegated task's child takes on the Foreman's work item. */
export const workItemRoleForTask = (
  taskRole: OrchestratorMcpTaskRole | undefined,
): FactoryRoleName | null =>
  taskRole === "implementation" ? "implement" : taskRole === "review" ? "review" : null;

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
