/**
 * Fork-only. Factory logic web and mobile share: what needs a person, the labels for stages and
 * actors, and the save that changes one role.
 */
import {
  type EnvironmentId,
  type Factory,
  type FactoryDefinition,
  type FactoryRole,
  type FactoryRoleChange,
  type FactoryRoleName,
  type FactorySaveInput,
  isTerminalWorkItemStage,
  WorkItemError,
  type WorkItemActor,
  type WorkItemAnswerGateInput,
  type WorkItemGateDecision,
  type WorkItemId,
  type WorkItemOutcome,
  type WorkItemStage,
  type WorkItemSummary,
  WorkItemTransitionError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { type EnvironmentThreadShell, threadRuntimeIsActive } from "./state/models.ts";

export type NeedsYouShell = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "archivedAt" | "settledOverride"
>;

export interface NeedsYouRow {
  readonly kind: "gate" | "failure";
  readonly item: WorkItemSummary;
}

/**
 * Mirrors the server's attention count (`FactoryService.loadOwnership`): a failed item asks for a
 * person unless a person failed it or dismissed the failure, or its run thread is settled,
 * archived, or gone. An item whose run never started has no thread to settle, so it keeps asking.
 */
function failureNeedsYou(item: WorkItemSummary, shell: NeedsYouShell | undefined): boolean {
  if (item.stage !== "failed" || item.failedByUser || item.failureDismissedAt !== null) {
    return false;
  }
  if (item.foremanThreadId === null) return true;
  return shell !== undefined && shell.archivedAt === null && shell.settledOverride !== "settled";
}

/** Gates to answer, then failures to acknowledge, each newest first as the lists come. */
export function needsYouRows(input: {
  readonly environmentId: EnvironmentId;
  readonly waiting: ReadonlyArray<WorkItemSummary>;
  readonly failed: ReadonlyArray<WorkItemSummary>;
  readonly shells: ReadonlyArray<NeedsYouShell>;
}): ReadonlyArray<NeedsYouRow> {
  const shellById = new Map<string, NeedsYouShell>();
  for (const shell of input.shells) {
    if (shell.environmentId === input.environmentId) shellById.set(shell.id, shell);
  }
  return [
    ...input.waiting
      .filter((item) => item.stage === "waiting")
      .map((item): NeedsYouRow => ({ kind: "gate", item })),
    ...input.failed
      .filter((item) =>
        failureNeedsYou(
          item,
          item.foremanThreadId === null ? undefined : shellById.get(item.foremanThreadId),
        ),
      )
      .map((item): NeedsYouRow => ({ kind: "failure", item })),
  ];
}

const sameRow = (left: NeedsYouRow, right: NeedsYouRow) =>
  left.kind === right.kind &&
  left.item.id === right.item.id &&
  left.item.title === right.item.title &&
  left.item.updatedAt === right.item.updatedAt &&
  left.item.foremanThreadId === right.item.foremanThreadId;

/** Returns the previous rows while nothing they show changed, so a shell tick renders nothing. */
export function createNeedsYouSelector() {
  let previous: ReadonlyArray<NeedsYouRow> | null = null;
  return (input: Parameters<typeof needsYouRows>[0]): ReadonlyArray<NeedsYouRow> => {
    const next = needsYouRows(input);
    if (
      previous !== null &&
      previous.length === next.length &&
      previous.every((row, index) => sameRow(row, next[index]!))
    ) {
      return previous;
    }
    previous = next;
    return next;
  };
}

/** The work item lists the "Needs you" rows read: gates waiting, and every failure. */
export const needsYouListInputs = (factoryId: Factory["id"]) =>
  ({
    waiting: { factoryId, stage: "waiting" },
    failed: { factoryId, outcome: "failed" },
  }) as const;

/** The role's file with `enabled` set, everything else kept. Absent means enabled. */
export function roleEnabledChange(role: FactoryRole, enabled: boolean): FactoryRoleChange {
  const { enabled: _enabled, ...binding } = role.fileBinding;
  return {
    role: role.role,
    file: {
      binding: enabled ? binding : { ...binding, enabled: false },
      body: role.bodySource === "file" ? role.body : null,
    },
  };
}

/** A save that writes the definition as read, with only the given changes. */
export function factorySaveInput(
  factory: Pick<Factory, "projectId" | "definition">,
  changes: {
    readonly definition?: Partial<Pick<FactoryDefinition, "roles">>;
    readonly roles?: ReadonlyArray<FactoryRoleChange>;
  },
): FactorySaveInput {
  return {
    projectId: factory.projectId,
    definition: { ...factory.definition, ...changes.definition, version: 2 },
    ...(changes.roles === undefined || changes.roles.length === 0 ? {} : { roles: changes.roles }),
  };
}

/**
 * Whether a save can keep the definition. A `factory.json` that could not be read comes back with
 * empty lists, so saving it would write those over the person's file.
 */
export function canSaveDefinition(factory: Pick<Factory, "issues">): boolean {
  return !factory.issues.some(
    (issue) => issue.role === null && issue.code === "invalid_definition" && issue.field === null,
  );
}

const STAGE_LABELS: Readonly<Record<WorkItemStage, string>> = {
  new: msg("New", { $context: "work item stage" }),
  working: msg("Working", { $context: "work item stage, its Foreman has delegated work" }),
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
export const factoryRoleLabel = (role: FactoryRoleName, resolve: MFunctionType): string =>
  Object.hasOwn(PRESET_ROLE_LABELS, role) ? resolve(PRESET_ROLE_LABELS[role]!) : role;

export const workItemStageLabel = (stage: WorkItemStage, resolve: MFunctionType): string =>
  resolve(STAGE_LABELS[stage]);

/** Every stage, in the order an item moves through them. */
export const WORK_ITEM_STAGES: ReadonlyArray<WorkItemStage> = [
  "new",
  "working",
  "waiting",
  "done",
  "failed",
  "dropped",
];

export type RunningRoleShell = Pick<EnvironmentThreadShell, "environmentId" | "id" | "runtime">;

export interface RunningRole {
  readonly role: FactoryRoleName;
  /** The item's threads of this role that are running. */
  readonly threadIds: ReadonlyArray<WorkItemSummary["threads"][number]["threadId"]>;
}

/** The roles with a running child on the item, in the order the item names them. */
export function runningRoles(
  item: Pick<WorkItemSummary, "threads">,
  environmentId: EnvironmentId,
  shells: ReadonlyArray<RunningRoleShell>,
): ReadonlyArray<RunningRole> {
  if (item.threads.length === 0) return [];
  const active = new Set<string>();
  for (const shell of shells) {
    if (shell.environmentId === environmentId && threadRuntimeIsActive(shell.runtime)) {
      active.add(shell.id);
    }
  }
  const byRole = new Map<FactoryRoleName, Array<RunningRole["threadIds"][number]>>();
  for (const thread of item.threads) {
    if (thread.role === null || !active.has(thread.threadId)) continue;
    const threadIds = byRole.get(thread.role);
    if (threadIds === undefined) byRole.set(thread.role, [thread.threadId]);
    else threadIds.push(thread.threadId);
  }
  return [...byRole].map(([role, threadIds]) => ({ role, threadIds }));
}

/** "Implement ×2, Review": each running role, with a count when more than one child runs it. */
export const runningRolesLabel = (
  roles: ReadonlyArray<RunningRole>,
  resolve: MFunctionType,
): string =>
  roles
    .map(({ role, threadIds }) =>
      threadIds.length > 1
        ? `${factoryRoleLabel(role, resolve)} ×${threadIds.length}`
        : factoryRoleLabel(role, resolve),
    )
    .join(", ");

export function workItemActorLabel(actor: WorkItemActor, resolve: MFunctionType): string {
  if (actor.kind === "foreman") return factoryRoleLabel("foreman", resolve);
  return actor.kind === "user"
    ? resolve(msg("Person", { $context: "who changed a work item: a human" }))
    : resolve(msg("Server", { $context: "who changed a work item: the T3 server" }));
}

/** Why the answer cannot be sent yet, or null. A rejection has to say why. */
export function gateAnswerError(
  decision: WorkItemGateDecision,
  note: string,
  resolve: MFunctionType,
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
  resolve: MFunctionType,
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
