import {
  type Factory,
  FactoryRoleName,
  isWorkItemRoleStage,
  WorkItemError,
  WorkItemOutcome,
  WorkItemStage,
  WorkItemTransitionError,
  type FactoryId,
  type WorkItemActor,
  type WorkItemAnswerGateInput,
  type WorkItemGateDecision,
  type WorkItemId,
  type WorkItemListInput,
  type WorkItemSource,
  type WorkItemSummary,
  type WorkItemThread,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** The factory page's work item filters, as its URL search params keep them. */
export interface WorkItemSearch {
  readonly stage?: WorkItemStage | undefined;
  readonly role?: FactoryRoleName | undefined;
  readonly outcome?: WorkItemOutcome | undefined;
}

const isStage = Schema.is(WorkItemStage);
const isRole = Schema.is(FactoryRoleName);
const isOutcome = Schema.is(WorkItemOutcome);

/** Drops any param that is not a known stage, role, or outcome, so a stale link shows everything. */
export function validateWorkItemSearch(raw: Record<string, unknown>): WorkItemSearch {
  return {
    ...(isStage(raw.stage) ? { stage: raw.stage } : {}),
    ...(isRole(raw.role) ? { role: raw.role } : {}),
    ...(isOutcome(raw.outcome) ? { outcome: raw.outcome } : {}),
  };
}

export function workItemListInput(factoryId: FactoryId, search: WorkItemSearch): WorkItemListInput {
  return {
    factoryId,
    ...(search.stage === undefined ? {} : { stage: search.stage }),
    ...(search.role === undefined ? {} : { role: search.role }),
    ...(search.outcome === undefined ? {} : { outcome: search.outcome }),
  };
}

const FIXED_STAGE_LABELS: Readonly<Record<string, string>> = {
  new: "New",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  dropped: "Dropped",
};

export const WORK_ITEM_OUTCOME_LABELS = {
  active: "Active",
  done: "Done",
  failed: "Failed",
  dropped: "Dropped",
} as const satisfies Record<WorkItemOutcome, string>;

const PRESET_ROLE_LABELS: Readonly<Record<string, string>> = {
  foreman: "Foreman",
  implement: "Implement",
  review: "Review",
};

/** A preset role's label; any other role shows as its name. */
export const factoryRoleLabel = (role: FactoryRoleName): string =>
  Object.hasOwn(PRESET_ROLE_LABELS, role) ? PRESET_ROLE_LABELS[role]! : role;

export const workItemStageLabel = (stage: WorkItemStage): string =>
  Object.hasOwn(FIXED_STAGE_LABELS, stage) ? FIXED_STAGE_LABELS[stage]! : factoryRoleLabel(stage);

/** The stages a factory's items can be at: new, its roles' stages in order, then the rest. */
export const factoryStages = (factory: Factory): ReadonlyArray<WorkItemStage> => [
  "new",
  ...factory.roles.map((role) => role.role).filter(isWorkItemRoleStage),
  "waiting",
  "done",
  "failed",
  "dropped",
];

/** A failure a person dismissed no longer reads as one that needs them. */
export function workItemStageBadgeVariant(
  stage: WorkItemStage,
  failureDismissed = false,
): "warning" | "destructive" | "outline" | "default" {
  switch (stage) {
    case "waiting":
      return "warning";
    case "failed":
      return failureDismissed ? "outline" : "destructive";
    case "done":
      return "outline";
    default:
      return "default";
  }
}

export function workItemSourceLabel(source: WorkItemSource): string {
  if (source.kind === "trigger") return source.title;
  return source.kind === "manual" ? "Manual" : "Scheduled task";
}

export function workItemActorLabel(actor: WorkItemActor): string {
  if (actor.kind === "foreman") return "Foreman";
  return actor.kind === "user" ? "Person" : "Server";
}

/** Why the answer cannot be sent yet, or null. A rejection has to say why. */
export function gateAnswerError(decision: WorkItemGateDecision, note: string): string | null {
  return decision === "rejected" && note.trim() === "" ? "Add a note to reject." : null;
}

export function gateAnswerInput(
  workItemId: WorkItemId,
  decision: WorkItemGateDecision,
  note: string,
): WorkItemAnswerGateInput {
  return { workItemId, decision, note: note.trim() };
}

const isWorkItemError = Schema.is(WorkItemError);
const isWorkItemTransitionError = Schema.is(WorkItemTransitionError);

/** The message to show inline for a failed work item command. */
export function workItemFailureMessage(error: unknown, fallback: string): string {
  if (isWorkItemError(error)) return error.message;
  if (isWorkItemTransitionError(error)) {
    return `The item cannot move from ${workItemStageLabel(error.from).toLowerCase()} to ${workItemStageLabel(error.to).toLowerCase()}.`;
  }
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

/** The item's own Foreman thread first, then each thread that worked on it, once each. */
export function workItemThreads(item: WorkItemSummary): ReadonlyArray<WorkItemThread> {
  const foreman: ReadonlyArray<WorkItemThread> =
    item.foremanThreadId === null ? [] : [{ threadId: item.foremanThreadId, role: "foreman" }];
  return [...foreman, ...item.threads.filter((thread) => thread.threadId !== item.foremanThreadId)];
}
