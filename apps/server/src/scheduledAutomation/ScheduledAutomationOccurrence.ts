import type { OrchestrationThreadShell, ScheduledAutomation } from "@t3tools/contracts";
import {
  CommandId,
  EventId,
  hasQueuedTurnStart,
  latestScheduledAutomationOccurrence,
  MessageId,
  parseScheduledAutomationSchedule,
  ScheduledAutomationId,
  ScheduledAutomationScheduleError,
  scheduledAutomationPlanningBoundary,
  ThreadId,
} from "@t3tools/contracts";
import * as Cron from "effect/Cron";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export const SCHEDULED_AUTOMATION_THREAD_PREFIX = "t3sa:v1";
export const SCHEDULED_AUTOMATION_WORKTREE_SUBTREE = "local-scheduled-automations-v1";
const isScheduledAutomationId = Schema.is(ScheduledAutomationId);

export function isScheduledAutomationThreadId(threadId: string): boolean {
  return threadId.startsWith(`${SCHEDULED_AUTOMATION_THREAD_PREFIX}:`);
}

export interface ScheduledAutomationThreadIdentity {
  readonly automationId: ScheduledAutomationId;
  readonly automationKey: string;
  readonly scheduledFor: string;
  readonly occurrenceKey: string;
}

/** Parses only canonical v1 thread identities minted by the derivation helper. */
export function parseScheduledAutomationThreadIdentity(
  threadId: string,
): ScheduledAutomationThreadIdentity | null {
  const match = /^t3sa:v1:([0-9a-f]+):([0-9a-f]+):thread$/.exec(threadId);
  if (match === null) return null;
  const automationKey = match[1];
  const occurrenceKey = match[2];
  if (automationKey === undefined || occurrenceKey === undefined) return null;

  const decodedAutomationId = Encoding.decodeHexString(automationKey);
  const decodedScheduledFor = Encoding.decodeHexString(occurrenceKey);
  if (Result.isFailure(decodedAutomationId) || Result.isFailure(decodedScheduledFor)) return null;
  const automationId = decodedAutomationId.success;
  const scheduledFor = decodedScheduledFor.success;
  if (!isScheduledAutomationId(automationId)) return null;
  if (Encoding.encodeHex(automationId) !== automationKey) return null;
  const instant = DateTime.make(scheduledFor);
  if (Option.isNone(instant) || DateTime.formatIso(instant.value) !== scheduledFor) return null;
  if (Encoding.encodeHex(scheduledFor) !== occurrenceKey) return null;

  return {
    automationId,
    automationKey,
    scheduledFor,
    occurrenceKey,
  };
}

export function scheduledAutomationThreadTitle(name: string): string {
  return `Automation: ${name}`;
}

function identityKey(input: string): string {
  return Encoding.encodeHex(input);
}

export class ScheduledAutomationOccurrenceIdentityError extends Data.TaggedError(
  "ScheduledAutomationOccurrenceIdentityError",
)<{
  readonly message: string;
}> {}

/**
 * Derives every durable orchestration and filesystem identity from the
 * occurrence tuple. Prompt/model data is intentionally absent from the input.
 */
export function deriveScheduledAutomationOccurrenceIdentity(
  input: {
    readonly automationId: ScheduledAutomationId;
    readonly scheduledFor: string;
    readonly worktreesDir: string;
  },
  path: Pick<Path.Path, "resolve">,
): Result.Result<
  {
    readonly automationKey: string;
    readonly occurrenceKey: string;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly bootstrapCommandId: CommandId;
    readonly phaseCommandIds: {
      readonly createThread: CommandId;
      readonly prepareWorktree: CommandId;
      readonly updateThreadMetadata: CommandId;
      readonly startTurn: CommandId;
      readonly recordFailure: CommandId;
    };
    readonly failureActivityId: EventId;
    readonly branch: string;
    readonly worktreePath: string;
  },
  ScheduledAutomationOccurrenceIdentityError
> {
  if (!/(?:z|[+-]\d{2}:?\d{2})$/i.test(input.scheduledFor)) {
    return Result.fail(
      new ScheduledAutomationOccurrenceIdentityError({
        message: "scheduledFor must identify an absolute date-time instant.",
      }),
    );
  }
  const scheduledFor = DateTime.make(input.scheduledFor);
  if (Option.isNone(scheduledFor)) {
    return Result.fail(
      new ScheduledAutomationOccurrenceIdentityError({
        message: "scheduledFor must be a valid date-time instant.",
      }),
    );
  }
  const canonicalScheduledFor = DateTime.formatIso(scheduledFor.value);
  const automationKey = identityKey(input.automationId);
  const occurrenceKey = identityKey(canonicalScheduledFor);
  const root = `${SCHEDULED_AUTOMATION_THREAD_PREFIX}:${automationKey}:${occurrenceKey}`;
  const bootstrapRoot = `${root}:command:bootstrap`;

  return Result.succeed({
    automationKey,
    occurrenceKey,
    threadId: ThreadId.make(`${root}:thread`),
    messageId: MessageId.make(`${root}:message:initial`),
    bootstrapCommandId: CommandId.make(bootstrapRoot),
    phaseCommandIds: {
      createThread: CommandId.make(`${bootstrapRoot}:phase:create-thread`),
      prepareWorktree: CommandId.make(`${bootstrapRoot}:phase:prepare-worktree`),
      updateThreadMetadata: CommandId.make(`${bootstrapRoot}:phase:update-thread-metadata`),
      startTurn: CommandId.make(`${bootstrapRoot}:phase:start-turn`),
      recordFailure: CommandId.make(`${bootstrapRoot}:phase:record-failure`),
    },
    failureActivityId: EventId.make(`${bootstrapRoot}:activity:failed`),
    branch: `t3/local-scheduled-automation/${automationKey}/${occurrenceKey}`,
    worktreePath: path.resolve(
      input.worktreesDir,
      SCHEDULED_AUTOMATION_WORKTREE_SUBTREE,
      automationKey,
      occurrenceKey,
    ),
  } as const);
}

export type ScheduledAutomationActivityShell = Pick<
  OrchestrationThreadShell,
  "session" | "hasPendingApprovals" | "hasPendingUserInput" | "latestUserMessageAt" | "latestTurn"
>;

/**
 * Overlap truth for the previous run. Settlement, archive, snooze, and age are
 * deliberately absent: only live or user-blocked work makes a run active.
 */
export function isScheduledAutomationThreadActive(
  shell: ScheduledAutomationActivityShell | null | undefined,
  options: { readonly now: string },
): boolean {
  if (shell == null) return false;
  if (shell.session?.status === "starting" || shell.session?.status === "running") return true;
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return true;
  if (hasQueuedTurnStart(shell, options)) return true;
  return shell.latestTurn?.state === "running";
}

export interface ScheduledAutomationOccurrencePlan {
  readonly scheduledFor: string;
  readonly coalescedCount: number;
}

const OCCURRENCE_COUNT_YIELD_INTERVAL = 256;

export interface ScheduledAutomationOccurrencePlannerOptions {
  /** Test seam for proving that large counts yield between bounded batches. */
  readonly yieldControl?: Effect.Effect<void>;
}

/**
 * Plans one latest-only claim from durable row truth. Counting walks only the
 * discarded occurrence identities; it never materializes or dispatches them.
 */
export const planScheduledAutomationOccurrence = Effect.fn("planScheduledAutomationOccurrence")(
  function* (
    automation: Pick<
      ScheduledAutomation,
      "enabled" | "enabledAt" | "lastScheduledFor" | "schedule"
    >,
    now: string,
    options: ScheduledAutomationOccurrencePlannerOptions = {},
  ) {
    if (!automation.enabled || automation.enabledAt === null) {
      return Result.succeed(Option.none());
    }
    const latest = latestScheduledAutomationOccurrence(automation.schedule, {
      enabledAt: automation.enabledAt,
      lastScheduledFor: automation.lastScheduledFor,
      now,
    });
    if (Result.isFailure(latest)) return Result.fail(latest.failure);
    if (Option.isNone(latest.success)) return Result.succeed(Option.none());

    const boundary = scheduledAutomationPlanningBoundary({
      enabledAt: automation.enabledAt,
      lastScheduledFor: automation.lastScheduledFor,
    });
    if (Result.isFailure(boundary)) return Result.fail(boundary.failure);

    if (automation.schedule.cron.trim() === "* * * * *" && automation.schedule.timeZone === "UTC") {
      const firstOccurrence = Math.floor(Date.parse(boundary.success) / 60_000) * 60_000 + 60_000;
      const coalescedCount = Math.floor(
        (Date.parse(latest.success.value) - firstOccurrence) / 60_000,
      );
      return Result.succeed(
        Option.some({
          scheduledFor: latest.success.value,
          coalescedCount: Math.max(0, coalescedCount),
        }),
      );
    }

    const parsedSchedule = parseScheduledAutomationSchedule(automation.schedule);
    if (Result.isFailure(parsedSchedule)) return Result.fail(parsedSchedule.failure);
    const next = (after: string) =>
      Result.try({
        try: () => Cron.next(parsedSchedule.success, after).toISOString(),
        catch: (error) =>
          new ScheduledAutomationScheduleError({
            field: "schedule.cron",
            message:
              error instanceof Error ? error.message : "Unable to compute a cron occurrence.",
          }),
      });
    let occurrence = next(boundary.success);
    if (Result.isFailure(occurrence)) return Result.fail(occurrence.failure);
    let coalescedCount = 0;
    while (occurrence.success !== latest.success.value) {
      coalescedCount += 1;
      if (coalescedCount % OCCURRENCE_COUNT_YIELD_INTERVAL === 0) {
        yield* options.yieldControl ?? Effect.yieldNow;
      }
      occurrence = next(occurrence.success);
      if (Result.isFailure(occurrence)) return Result.fail(occurrence.failure);
    }

    return Result.succeed(
      Option.some({
        scheduledFor: latest.success.value,
        coalescedCount,
      }),
    );
  },
);
