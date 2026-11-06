import {
  FactoryRoleName,
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

export const WORK_ITEM_STAGE_LABELS = {
  queued: "Queued",
  new: "New",
  implement: "Implement",
  review: "Review",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  dropped: "Dropped",
} as const satisfies Record<WorkItemStage, string>;

export const WORK_ITEM_OUTCOME_LABELS = {
  active: "Active",
  done: "Done",
  failed: "Failed",
  dropped: "Dropped",
} as const satisfies Record<WorkItemOutcome, string>;

export const FACTORY_ROLE_LABELS = {
  foreman: "Foreman",
  implement: "Implement",
  review: "Review",
} as const satisfies Record<FactoryRoleName, string>;

export function workItemStageBadgeVariant(
  stage: WorkItemStage,
): "warning" | "destructive" | "outline" | "default" {
  switch (stage) {
    case "waiting":
      return "warning";
    case "failed":
      return "destructive";
    case "queued":
    case "done":
      return "outline";
    default:
      return "default";
  }
}

export function workItemSourceLabel(source: WorkItemSource): string {
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
    return `The item cannot move from ${WORK_ITEM_STAGE_LABELS[error.from].toLowerCase()} to ${WORK_ITEM_STAGE_LABELS[error.to].toLowerCase()}.`;
  }
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

/** The Foreman's thread first, then each thread that worked on the item, once each. */
export function workItemThreads(item: WorkItemSummary): ReadonlyArray<WorkItemThread> {
  const foreman: ReadonlyArray<WorkItemThread> =
    item.foremanThreadId === null ? [] : [{ threadId: item.foremanThreadId, role: "foreman" }];
  return [...foreman, ...item.threads.filter((thread) => thread.threadId !== item.foremanThreadId)];
}
