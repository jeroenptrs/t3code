import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  ModelSelection,
  OrchestrationThreadShell,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderInteractionMode,
  RuntimeMode,
} from "./orchestration.ts";

export const SCHEDULED_AUTOMATION_WS_METHODS = {
  dispatchCommand: "scheduledAutomation.dispatchCommand",
  list: "scheduledAutomation.list",
  get: "scheduledAutomation.get",
  subscribe: "scheduledAutomation.subscribe",
} as const;

const SCHEDULED_AUTOMATION_ID_MAX_CHARS = 64;
const SCHEDULED_AUTOMATION_NAME_MAX_CHARS = 160;
export const SCHEDULED_AUTOMATION_FAILURE_DETAIL_MAX_CHARS = 1_000;

export const ScheduledAutomationId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SCHEDULED_AUTOMATION_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/i),
).pipe(Schema.brand("ScheduledAutomationId"));
export type ScheduledAutomationId = typeof ScheduledAutomationId.Type;

export const ScheduledAutomationScheduleErrorField = Schema.Literals([
  "schedule.cron",
  "schedule.timeZone",
  "after",
  "enabledAt",
  "lastScheduledFor",
  "now",
]);
export type ScheduledAutomationScheduleErrorField =
  typeof ScheduledAutomationScheduleErrorField.Type;

export class ScheduledAutomationScheduleError extends Schema.TaggedErrorClass<ScheduledAutomationScheduleError>()(
  "ScheduledAutomationScheduleError",
  {
    field: ScheduledAutomationScheduleErrorField,
    message: TrimmedNonEmptyString,
  },
) {}

const hasFiveCronFields = (input: string): boolean =>
  input.split(/\s+/).filter((segment) => segment.length > 0).length === 5;

const validateFiveFieldCron = (input: string): true | string => {
  if (!hasFiveCronFields(input)) {
    return "Cron must contain exactly five fields: minute hour day-of-month month day-of-week.";
  }
  const parsed = Cron.parse(input, "UTC");
  if (Result.isFailure(parsed)) return parsed.failure.message;
  const occurrence = cronNextResult(parsed.success, "2000-01-01T00:00:00.000Z");
  return Result.isSuccess(occurrence)
    ? true
    : "Cron must have at least one computable calendar occurrence.";
};

/** Five-field Effect Cron syntax. Seconds are intentionally not configurable in v1. */
export const ScheduledAutomationCron = TrimmedNonEmptyString.check(
  Schema.makeFilter(validateFiveFieldCron),
);
export type ScheduledAutomationCron = typeof ScheduledAutomationCron.Type;

/** Required IANA named time zone; numeric offsets are not accepted. */
const isIanaNamedTimeZone = (input: string): boolean =>
  !/^(?:[+-]|(?:gmt|utc)[+-])/i.test(input) && Option.isSome(DateTime.zoneMakeNamed(input));

export const ScheduledAutomationTimeZone = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (input) =>
      isIanaNamedTimeZone(input) || "timeZone must be a valid IANA named time-zone identifier.",
  ),
);
export type ScheduledAutomationTimeZone = typeof ScheduledAutomationTimeZone.Type;

export const ScheduledAutomationSchedule = Schema.Struct({
  cron: ScheduledAutomationCron,
  timeZone: ScheduledAutomationTimeZone,
  // Downtime coalesces all eligible missed instants to the newest one; v1
  // never starts a backlog of old occurrences.
  misfirePolicy: Schema.Literal("latest-only"),
});
export type ScheduledAutomationSchedule = typeof ScheduledAutomationSchedule.Type;

export const ScheduledAutomationWorktreePolicy = Schema.Union([
  // The selected project's current workspace is shared and provides no
  // filesystem isolation from users or other automations.
  Schema.Struct({ kind: Schema.Literal("current") }),
  // Each occurrence uses a deterministic branch and worktree below the
  // server-owned automation subtree; later retention still requires Git proof.
  Schema.Struct({
    kind: Schema.Literal("new-worktree"),
    baseBranch: TrimmedNonEmptyString,
    startFromOrigin: Schema.Boolean,
  }),
]);
export type ScheduledAutomationWorktreePolicy = typeof ScheduledAutomationWorktreePolicy.Type;

export const ScheduledAutomationDefinition = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(SCHEDULED_AUTOMATION_NAME_MAX_CHARS)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  projectId: ProjectId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  worktreePolicy: ScheduledAutomationWorktreePolicy,
  /** Unattended v1 runs never launch project setup scripts. */
  setupScriptPolicy: Schema.Literal("skip"),
  schedule: ScheduledAutomationSchedule,
});
export type ScheduledAutomationDefinition = typeof ScheduledAutomationDefinition.Type;

/**
 * Management-wire shape. User-editable strings remain drafts so invalid cron,
 * timezone, and other definition fields reach the server service and can be
 * returned as field-addressed validation errors. Durable rows always use
 * `ScheduledAutomationDefinition` instead.
 */
export const ScheduledAutomationDefinitionDraft = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(1_000)),
  prompt: Schema.String.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  projectId: ProjectId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  worktreePolicy: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("current") }),
    Schema.Struct({
      kind: Schema.Literal("new-worktree"),
      baseBranch: Schema.String.check(Schema.isMaxLength(1_024)),
      startFromOrigin: Schema.Boolean,
    }),
  ]),
  setupScriptPolicy: Schema.String.check(Schema.isMaxLength(64)),
  schedule: Schema.Struct({
    cron: Schema.String.check(Schema.isMaxLength(256)),
    timeZone: Schema.String.check(Schema.isMaxLength(256)),
    misfirePolicy: Schema.String.check(Schema.isMaxLength(64)),
  }),
});
export type ScheduledAutomationDefinitionDraft = typeof ScheduledAutomationDefinitionDraft.Type;

const ScheduledAutomationOutcomeCommon = {
  scheduledFor: IsoDateTime,
  observedAt: IsoDateTime,
  /** Eligible earlier occurrences discarded by `latest-only`; zero when exactly one was due. */
  coalescedCount: NonNegativeInt,
};

export const ScheduledAutomationOutcome = Schema.Union([
  Schema.Struct({
    ...ScheduledAutomationOutcomeCommon,
    kind: Schema.Literal("starting"),
  }),
  Schema.Struct({
    ...ScheduledAutomationOutcomeCommon,
    kind: Schema.Literal("started"),
  }),
  Schema.Struct({
    ...ScheduledAutomationOutcomeCommon,
    kind: Schema.Literal("skipped-active"),
    previousThreadId: ThreadId,
  }),
  Schema.Struct({
    ...ScheduledAutomationOutcomeCommon,
    kind: Schema.Literal("failed"),
    code: TrimmedNonEmptyString.check(
      Schema.isMaxLength(80),
      Schema.isPattern(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
    ),
    detail: TrimmedNonEmptyString.check(
      Schema.isMaxLength(SCHEDULED_AUTOMATION_FAILURE_DETAIL_MAX_CHARS),
    ),
  }),
]);
export type ScheduledAutomationOutcome = typeof ScheduledAutomationOutcome.Type;

export const ScheduledAutomation = Schema.Struct({
  id: ScheduledAutomationId,
  revision: PositiveInt,
  ...ScheduledAutomationDefinition.fields,
  enabled: Schema.Boolean,
  enabledAt: Schema.NullOr(IsoDateTime),
  lastScheduledFor: Schema.NullOr(IsoDateTime),
  lastThreadId: Schema.NullOr(ThreadId),
  lastOutcome: Schema.NullOr(ScheduledAutomationOutcome),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ScheduledAutomation = typeof ScheduledAutomation.Type;

export const ScheduledAutomationVisibleStatus = Schema.Literals([
  "never-run",
  "starting",
  "running",
  "blocked",
  "completed",
  "failed",
  "interrupted",
  "skipped-active",
  "thread-missing",
]);
export type ScheduledAutomationVisibleStatus = typeof ScheduledAutomationVisibleStatus.Type;

export const ScheduledAutomationView = Schema.Struct({
  automation: ScheduledAutomation,
  status: ScheduledAutomationVisibleStatus,
  nextScheduledFor: Schema.NullOr(IsoDateTime),
  lastThread: Schema.NullOr(OrchestrationThreadShell),
});
export type ScheduledAutomationView = typeof ScheduledAutomationView.Type;

const ScheduledAutomationRevisionFields = {
  commandId: CommandId,
  automationId: ScheduledAutomationId,
  expectedRevision: PositiveInt,
  createdAt: IsoDateTime,
};

export const ScheduledAutomationCreateCommand = Schema.Struct({
  type: Schema.Literal("scheduledAutomation.create"),
  commandId: CommandId,
  automationId: ScheduledAutomationId,
  definition: ScheduledAutomationDefinitionDraft,
  createdAt: IsoDateTime,
});
export type ScheduledAutomationCreateCommand = typeof ScheduledAutomationCreateCommand.Type;

export const ScheduledAutomationUpdateCommand = Schema.Struct({
  type: Schema.Literal("scheduledAutomation.update"),
  ...ScheduledAutomationRevisionFields,
  definition: ScheduledAutomationDefinitionDraft,
});
export type ScheduledAutomationUpdateCommand = typeof ScheduledAutomationUpdateCommand.Type;

export const ScheduledAutomationEnabledSetCommand = Schema.Struct({
  type: Schema.Literal("scheduledAutomation.enabled.set"),
  ...ScheduledAutomationRevisionFields,
  enabled: Schema.Boolean,
});
export type ScheduledAutomationEnabledSetCommand = typeof ScheduledAutomationEnabledSetCommand.Type;

export const ScheduledAutomationRetryLastCommand = Schema.Struct({
  type: Schema.Literal("scheduledAutomation.retry-last"),
  ...ScheduledAutomationRevisionFields,
});
export type ScheduledAutomationRetryLastCommand = typeof ScheduledAutomationRetryLastCommand.Type;

export const ScheduledAutomationDeleteCommand = Schema.Struct({
  type: Schema.Literal("scheduledAutomation.delete"),
  ...ScheduledAutomationRevisionFields,
});
export type ScheduledAutomationDeleteCommand = typeof ScheduledAutomationDeleteCommand.Type;

export const ScheduledAutomationCommand = Schema.Union([
  ScheduledAutomationCreateCommand,
  ScheduledAutomationUpdateCommand,
  ScheduledAutomationEnabledSetCommand,
  ScheduledAutomationRetryLastCommand,
  ScheduledAutomationDeleteCommand,
]);
export type ScheduledAutomationCommand = typeof ScheduledAutomationCommand.Type;

export const ScheduledAutomationValidationField = Schema.Literals([
  "name",
  "prompt",
  "projectId",
  "modelSelection",
  "runtimeMode",
  "interactionMode",
  "worktreePolicy",
  "worktreePolicy.baseBranch",
  "setupScriptPolicy",
  "schedule.cron",
  "schedule.timeZone",
  "schedule.misfirePolicy",
]);
export type ScheduledAutomationValidationField = typeof ScheduledAutomationValidationField.Type;

export class ScheduledAutomationValidationError extends Schema.TaggedErrorClass<ScheduledAutomationValidationError>()(
  "ScheduledAutomationValidationError",
  {
    field: ScheduledAutomationValidationField,
    message: TrimmedNonEmptyString,
  },
) {}

export class ScheduledAutomationNotFoundError extends Schema.TaggedErrorClass<ScheduledAutomationNotFoundError>()(
  "ScheduledAutomationNotFoundError",
  { automationId: ScheduledAutomationId },
) {}

export class ScheduledAutomationConflictError extends Schema.TaggedErrorClass<ScheduledAutomationConflictError>()(
  "ScheduledAutomationConflictError",
  { current: ScheduledAutomation },
) {}

export class ScheduledAutomationInvalidStateError extends Schema.TaggedErrorClass<ScheduledAutomationInvalidStateError>()(
  "ScheduledAutomationInvalidStateError",
  {
    automationId: ScheduledAutomationId,
    message: TrimmedNonEmptyString,
    current: ScheduledAutomation,
  },
) {}

export const ScheduledAutomationError = Schema.Union([
  ScheduledAutomationValidationError,
  ScheduledAutomationNotFoundError,
  ScheduledAutomationConflictError,
  ScheduledAutomationInvalidStateError,
  ScheduledAutomationScheduleError,
]);
export type ScheduledAutomationError = typeof ScheduledAutomationError.Type;

const decodeDefinitionName = Schema.decodeUnknownResult(ScheduledAutomationDefinition.fields.name);
const decodeDefinitionPrompt = Schema.decodeUnknownResult(
  ScheduledAutomationDefinition.fields.prompt,
);
const decodeDefinitionBaseBranch = Schema.decodeUnknownResult(
  ScheduledAutomationWorktreePolicy.members[1].fields.baseBranch,
);
const decodeDefinitionSetupPolicy = Schema.decodeUnknownResult(
  ScheduledAutomationDefinition.fields.setupScriptPolicy,
);
const decodeDefinitionCron = Schema.decodeUnknownResult(ScheduledAutomationCron);
const decodeDefinitionTimeZone = Schema.decodeUnknownResult(ScheduledAutomationTimeZone);
const decodeDefinitionMisfirePolicy = Schema.decodeUnknownResult(
  ScheduledAutomationSchedule.fields.misfirePolicy,
);

function definitionValidationError(
  field: ScheduledAutomationValidationField,
  error: { readonly message: string },
): ScheduledAutomationValidationError {
  return new ScheduledAutomationValidationError({ field, message: error.message });
}

/** Converts a management draft into the only shape permitted in durable state. */
export function validateScheduledAutomationDefinitionDraft(
  draft: ScheduledAutomationDefinitionDraft,
): Result.Result<ScheduledAutomationDefinition, ScheduledAutomationValidationError> {
  const name = decodeDefinitionName(draft.name);
  if (Result.isFailure(name)) return Result.fail(definitionValidationError("name", name.failure));
  const prompt = decodeDefinitionPrompt(draft.prompt);
  if (Result.isFailure(prompt)) {
    return Result.fail(definitionValidationError("prompt", prompt.failure));
  }
  const setupScriptPolicy = decodeDefinitionSetupPolicy(draft.setupScriptPolicy);
  if (Result.isFailure(setupScriptPolicy)) {
    return Result.fail(definitionValidationError("setupScriptPolicy", setupScriptPolicy.failure));
  }
  const cron = decodeDefinitionCron(draft.schedule.cron);
  if (Result.isFailure(cron)) {
    return Result.fail(definitionValidationError("schedule.cron", cron.failure));
  }
  const timeZone = decodeDefinitionTimeZone(draft.schedule.timeZone);
  if (Result.isFailure(timeZone)) {
    return Result.fail(definitionValidationError("schedule.timeZone", timeZone.failure));
  }
  const misfirePolicy = decodeDefinitionMisfirePolicy(draft.schedule.misfirePolicy);
  if (Result.isFailure(misfirePolicy)) {
    return Result.fail(definitionValidationError("schedule.misfirePolicy", misfirePolicy.failure));
  }

  let worktreePolicy: ScheduledAutomationWorktreePolicy;
  if (draft.worktreePolicy.kind === "current") {
    worktreePolicy = draft.worktreePolicy;
  } else {
    const baseBranch = decodeDefinitionBaseBranch(draft.worktreePolicy.baseBranch);
    if (Result.isFailure(baseBranch)) {
      return Result.fail(
        definitionValidationError("worktreePolicy.baseBranch", baseBranch.failure),
      );
    }
    worktreePolicy = { ...draft.worktreePolicy, baseBranch: baseBranch.success };
  }

  return Result.succeed({
    name: name.success,
    prompt: prompt.success,
    projectId: draft.projectId,
    modelSelection: draft.modelSelection,
    runtimeMode: draft.runtimeMode,
    interactionMode: draft.interactionMode,
    worktreePolicy,
    setupScriptPolicy: setupScriptPolicy.success,
    schedule: {
      cron: cron.success,
      timeZone: timeZone.success,
      misfirePolicy: misfirePolicy.success,
    },
  });
}

export const ScheduledAutomationDispatchResult = Schema.Struct({
  automation: Schema.NullOr(ScheduledAutomation),
});
export type ScheduledAutomationDispatchResult = typeof ScheduledAutomationDispatchResult.Type;

export const ScheduledAutomationListResult = Schema.Struct({
  automations: Schema.Array(ScheduledAutomationView),
});
export type ScheduledAutomationListResult = typeof ScheduledAutomationListResult.Type;

export const ScheduledAutomationGetInput = Schema.Struct({
  automationId: ScheduledAutomationId,
});
export type ScheduledAutomationGetInput = typeof ScheduledAutomationGetInput.Type;

export const ScheduledAutomationStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    automations: Schema.Array(ScheduledAutomationView),
  }),
  Schema.Struct({
    kind: Schema.Literal("upserted"),
    automation: ScheduledAutomationView,
  }),
  Schema.Struct({
    kind: Schema.Literal("removed"),
    automationId: ScheduledAutomationId,
  }),
]);
export type ScheduledAutomationStreamItem = typeof ScheduledAutomationStreamItem.Type;

export const ScheduledAutomationRpcSchemas = {
  dispatchCommand: {
    input: ScheduledAutomationCommand,
    output: ScheduledAutomationDispatchResult,
  },
  list: {
    input: Schema.Struct({}),
    output: ScheduledAutomationListResult,
  },
  get: {
    input: ScheduledAutomationGetInput,
    output: ScheduledAutomationView,
  },
  subscribe: {
    input: Schema.Struct({}),
    output: ScheduledAutomationStreamItem,
  },
} as const;

function scheduleError(
  field: ScheduledAutomationScheduleErrorField,
  message: string,
): ScheduledAutomationScheduleError {
  return new ScheduledAutomationScheduleError({ field, message });
}

function thrownErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Unable to compute a cron occurrence.";
}

function cronNextResult(
  cron: Cron.Cron,
  after: DateTime.DateTime.Input,
): Result.Result<Date, ScheduledAutomationScheduleError> {
  return Result.try({
    try: () => Cron.next(cron, after),
    catch: (error) => scheduleError("schedule.cron", thrownErrorMessage(error)),
  });
}

/** Parses a validated v1 schedule without consulting an ambient clock. */
export function parseScheduledAutomationSchedule(
  schedule: ScheduledAutomationSchedule,
): Result.Result<Cron.Cron, ScheduledAutomationScheduleError> {
  if (!hasFiveCronFields(schedule.cron)) {
    return Result.fail(
      scheduleError(
        "schedule.cron",
        "Cron must contain exactly five fields: minute hour day-of-month month day-of-week.",
      ),
    );
  }
  const zone = DateTime.zoneMakeNamed(schedule.timeZone);
  if (!isIanaNamedTimeZone(schedule.timeZone) || Option.isNone(zone)) {
    return Result.fail(
      scheduleError(
        "schedule.timeZone",
        "timeZone must be a valid IANA named time-zone identifier.",
      ),
    );
  }
  return Cron.parse(schedule.cron, zone.value).pipe(
    Result.mapError((error) => scheduleError("schedule.cron", error.message)),
  );
}

function parseInstant(
  input: string,
  label: Extract<
    ScheduledAutomationScheduleErrorField,
    "after" | "enabledAt" | "lastScheduledFor" | "now"
  >,
): Result.Result<DateTime.DateTime, ScheduledAutomationScheduleError> {
  return DateTime.make(input).pipe(
    Option.match({
      onNone: () =>
        Result.fail(scheduleError(label, `${label} must be a valid date-time instant.`)),
      onSome: Result.succeed,
    }),
  );
}

function formatUtc(input: DateTime.DateTime.Input): string {
  return DateTime.make(input).pipe(Option.map(DateTime.formatIso), Option.getOrThrow);
}

/** Returns the first occurrence strictly after `after`. */
export function nextScheduledAutomationOccurrence(
  schedule: ScheduledAutomationSchedule,
  after: string,
): Result.Result<string, ScheduledAutomationScheduleError> {
  const parsedSchedule = parseScheduledAutomationSchedule(schedule);
  if (Result.isFailure(parsedSchedule)) return Result.fail(parsedSchedule.failure);
  const parsedAfter = parseInstant(after, "after");
  if (Result.isFailure(parsedAfter)) return Result.fail(parsedAfter.failure);
  const occurrence = cronNextResult(parsedSchedule.success, parsedAfter.success);
  if (Result.isFailure(occurrence)) return Result.fail(occurrence.failure);
  return Result.succeed(formatUtc(occurrence.success));
}

/**
 * Implements v1 `latest-only`: at most one newest occurrence at or before now,
 * strictly after both the activation boundary and durable cursor.
 */
export function latestScheduledAutomationOccurrence(
  schedule: ScheduledAutomationSchedule,
  input: {
    readonly enabledAt: string | null;
    readonly lastScheduledFor: string | null;
    readonly now: string;
  },
): Result.Result<Option.Option<string>, ScheduledAutomationScheduleError> {
  if (input.enabledAt === null) return Result.succeed(Option.none());

  const parsedSchedule = parseScheduledAutomationSchedule(schedule);
  if (Result.isFailure(parsedSchedule)) return Result.fail(parsedSchedule.failure);
  const now = parseInstant(input.now, "now");
  if (Result.isFailure(now)) return Result.fail(now.failure);
  const enabledAt = parseInstant(input.enabledAt, "enabledAt");
  if (Result.isFailure(enabledAt)) return Result.fail(enabledAt.failure);

  let boundary = DateTime.toEpochMillis(enabledAt.success);
  if (input.lastScheduledFor !== null) {
    const cursor = parseInstant(input.lastScheduledFor, "lastScheduledFor");
    if (Result.isFailure(cursor)) return Result.fail(cursor.failure);
    boundary = Math.max(boundary, DateTime.toEpochMillis(cursor.success));
  }

  const nowMs = DateTime.toEpochMillis(now.success);
  const first = cronNextResult(parsedSchedule.success, boundary);
  if (Result.isFailure(first)) return Result.fail(first.failure);
  if (first.success.getTime() > nowMs) return Result.succeed(Option.none());

  // `Cron.prev` is not the inverse of `Cron.next` around DST gaps/repeated
  // hours. Binary-search the monotonic forward sequence instead. This stays
  // O(log elapsed milliseconds), independent of the number of missed runs.
  let low = boundary;
  let high = nowMs;
  let latest = first.success;
  while (low <= high) {
    const midpoint = low + Math.floor((high - low) / 2);
    const next = cronNextResult(parsedSchedule.success, midpoint);
    if (Result.isFailure(next)) return Result.fail(next.failure);
    if (next.success.getTime() <= nowMs) {
      latest = next.success;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return Result.succeed(Option.some(formatUtc(latest)));
}
