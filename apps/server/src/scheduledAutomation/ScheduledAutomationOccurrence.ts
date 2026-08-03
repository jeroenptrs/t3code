import type { OrchestrationThreadShell, ScheduledAutomationId } from "@t3tools/contracts";
import { CommandId, EventId, hasQueuedTurnStart, MessageId, ThreadId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Result from "effect/Result";

export const SCHEDULED_AUTOMATION_THREAD_PREFIX = "t3sa:v1";
export const SCHEDULED_AUTOMATION_WORKTREE_SUBTREE = "local-scheduled-automations-v1";

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
