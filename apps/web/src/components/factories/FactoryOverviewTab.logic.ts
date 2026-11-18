import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, WorkItemSummary } from "@t3tools/contracts";

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
