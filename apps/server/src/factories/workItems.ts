/**
 * Fork-only work item helpers for `FactoryService`: the messages the Foreman reads and the role a
 * delegated task's child takes on an item. Plain functions; the ledger itself is in the service.
 */
import type {
  FactoryName,
  FactoryRoleName,
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
  const from =
    input.source.kind === "manual"
      ? "a person's request"
      : `scheduled task ${input.source.scheduledTaskId}`;
  return `Work item ${input.workItemId} for the ${input.factoryName} factory, from ${from}.

Title: ${input.title}

${input.source.text.trim()}

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
