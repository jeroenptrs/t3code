import {
  WorkItemOutcome,
  WorkItemStage,
  type FactoryId,
  type WorkItemListInput,
  type WorkItemSource,
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
