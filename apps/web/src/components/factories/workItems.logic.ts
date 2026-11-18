import {
  type Factory,
  type FactoryRoleName,
  isTerminalWorkItemStage,
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
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

/** The work item filters, as the factory page's URL search params keep them. */
export interface WorkItemSearch {
  readonly stage?: WorkItemStage | undefined;
  readonly outcome?: WorkItemOutcome | undefined;
}

const isStage = Schema.is(WorkItemStage);
const isOutcome = Schema.is(WorkItemOutcome);

/** Drops any param that is not a known stage or outcome, so a stale link shows everything. */
export function validateWorkItemSearch(raw: Record<string, unknown>): WorkItemSearch {
  return {
    ...(isStage(raw.stage) ? { stage: raw.stage } : {}),
    ...(isOutcome(raw.outcome) ? { outcome: raw.outcome } : {}),
  };
}

export function workItemListInput(factoryId: FactoryId, search: WorkItemSearch): WorkItemListInput {
  return {
    factoryId,
    ...(search.stage === undefined ? {} : { stage: search.stage }),
    ...(search.outcome === undefined ? {} : { outcome: search.outcome }),
  };
}

export const isWorkItemSearchFiltered = (search: WorkItemSearch): boolean =>
  search.stage !== undefined || search.outcome !== undefined;

const FIXED_STAGE_LABELS: Readonly<Record<string, string>> = {
  new: msg("New", { $context: "work item stage" }),
  waiting: msg("Waiting", { $context: "work item stage, a gate holds it for a person" }),
  done: msg("Done", { $context: "work item stage" }),
  failed: msg("Failed", { $context: "work item stage" }),
  dropped: msg("Dropped", { $context: "work item stage" }),
};

export const WORK_ITEM_OUTCOME_LABELS = {
  active: msg("Active", { $context: "work item outcome, not ended yet" }),
  done: msg("Done", { $context: "work item stage" }),
  failed: msg("Failed", { $context: "work item stage" }),
  dropped: msg("Dropped", { $context: "work item stage" }),
} as const satisfies Record<WorkItemOutcome, string>;

const PRESET_ROLE_LABELS: Readonly<Record<string, string>> = {
  foreman: msg("Foreman", { $context: "factory role that routes work" }),
  implement: msg("Implement", { $context: "factory role name" }),
  review: msg("Review", { $context: "factory role name" }),
};

/** A preset role's label; any other role shows as its name. */
export const factoryRoleLabel = (role: FactoryRoleName, resolve: MessageResolver = m): string =>
  Object.hasOwn(PRESET_ROLE_LABELS, role) ? resolve(PRESET_ROLE_LABELS[role]!) : role;

export const workItemStageLabel = (stage: WorkItemStage, resolve: MessageResolver = m): string =>
  Object.hasOwn(FIXED_STAGE_LABELS, stage)
    ? resolve(FIXED_STAGE_LABELS[stage]!)
    : factoryRoleLabel(stage, resolve);

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

export function workItemSourceLabel(source: WorkItemSource, resolve: MessageResolver = m): string {
  if (source.kind === "trigger") return source.title;
  return source.kind === "manual"
    ? resolve(msg("Manual", { $context: "work started by hand" }))
    : resolve(msg("Scheduled task"));
}

export function workItemActorLabel(actor: WorkItemActor, resolve: MessageResolver = m): string {
  if (actor.kind === "foreman") return factoryRoleLabel("foreman", resolve);
  return actor.kind === "user"
    ? resolve(msg("Person", { $context: "who changed a work item: a human" }))
    : resolve(msg("Server", { $context: "who changed a work item: the T3 server" }));
}

/** Why the answer cannot be sent yet, or null. A rejection has to say why. */
export function gateAnswerError(
  decision: WorkItemGateDecision,
  note: string,
  resolve: MessageResolver = m,
): string | null {
  return decision === "rejected" && note.trim() === ""
    ? resolve(msg("Add a note to reject."))
    : null;
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
export function workItemFailureMessage(
  error: unknown,
  fallback: string,
  resolve: MessageResolver = m,
): string {
  if (isWorkItemError(error)) return error.message;
  if (isWorkItemTransitionError(error)) {
    return resolve(
      msg("The item cannot move from {from} to {to}.", {
        from: workItemStageLabel(error.from, resolve).toLowerCase(),
        to: workItemStageLabel(error.to, resolve).toLowerCase(),
      }),
    );
  }
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

/** A person can drop an item until it ends. */
export const canDropWorkItem = (item: Pick<WorkItemSummary, "stage">): boolean =>
  !isTerminalWorkItemStage(item.stage);

/** Whether the item reads as a failure a person dismissed. */
export const isDismissedFailure = (
  item: Pick<WorkItemSummary, "stage" | "failureDismissedAt">,
): boolean => item.stage === "failed" && item.failureDismissedAt !== null;
