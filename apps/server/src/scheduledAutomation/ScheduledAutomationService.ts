import {
  nextScheduledAutomationOccurrence,
  scheduledAutomationPlanningBoundary,
  ScheduledAutomationConflictError,
  SCHEDULED_AUTOMATION_ABANDONED_CODE,
  SCHEDULED_AUTOMATION_BOOTSTRAP_PHASE_REJECTED_CODE,
  type ScheduledAutomation,
  type ScheduledAutomationCommand,
  type ScheduledAutomationDefinition,
  ScheduledAutomationInternalError,
  ScheduledAutomationInvalidStateError,
  ScheduledAutomationNotFoundError,
  type ScheduledAutomationStreamItem,
  ScheduledAutomationValidationError,
  type ScheduledAutomationView,
  validateScheduledAutomationDefinitionDraft,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { isScheduledAutomationThreadActive } from "./ScheduledAutomationOccurrence.ts";
import {
  ScheduledAutomationRepository,
  type ScheduledAutomationRepositoryError,
} from "./ScheduledAutomationRepository.ts";
import { ScheduledAutomationScheduler } from "./ScheduledAutomationScheduler.ts";
import { ScheduledAutomationValidation } from "./ScheduledAutomationValidation.ts";

type ManagementError =
  | ScheduledAutomationValidationError
  | ScheduledAutomationNotFoundError
  | ScheduledAutomationConflictError
  | ScheduledAutomationInvalidStateError
  | ScheduledAutomationInternalError;

export interface ScheduledAutomationServiceShape {
  readonly dispatch: (
    command: ScheduledAutomationCommand,
  ) => Effect.Effect<{ readonly automation: ScheduledAutomation | null }, ManagementError>;
  readonly list: () => Effect.Effect<
    ReadonlyArray<ScheduledAutomationView>,
    ScheduledAutomationInternalError
  >;
  readonly get: (
    automationId: ScheduledAutomation["id"],
  ) => Effect.Effect<
    ScheduledAutomationView,
    ScheduledAutomationNotFoundError | ScheduledAutomationInternalError
  >;
  readonly subscribe: Effect.Effect<
    Stream.Stream<ScheduledAutomationStreamItem, ScheduledAutomationInternalError>,
    never,
    import("effect/Scope").Scope
  >;
}

export class ScheduledAutomationService extends Context.Service<
  ScheduledAutomationService,
  ScheduledAutomationServiceShape
>()("t3/scheduledAutomation/ScheduledAutomationService") {}

const internalError = (operation: string) => (_cause: unknown) =>
  new ScheduledAutomationInternalError({
    message: `Scheduled automation ${operation} failed.`,
  });

function mapInternalFailure(operation: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError((cause) =>
        Effect.logError(
          `Scheduled automation ${operation} failed.`,
          internalFailureAttributes(cause),
        ),
      ),
      Effect.mapError(internalError(operation)),
    );
}

function internalFailureAttributes(cause: unknown): Readonly<Record<string, unknown>> {
  if (typeof cause !== "object" || cause === null) return { errorType: typeof cause };
  const error = cause as Record<string, unknown>;
  const attributes: Record<string, unknown> = {};
  if (typeof error._tag === "string") attributes.errorTag = error._tag;
  if (typeof error.operation === "string") attributes.operation = error.operation;
  if (error._tag === "PersistenceSqlError" && typeof error.detail === "string") {
    attributes.detail = error.detail;
  }
  if (error._tag === "PersistenceDecodeError" && typeof error.issue === "string") {
    attributes.issue = error.issue;
  }
  return attributes;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function replacement(
  automation: ScheduledAutomation,
  changes: Partial<
    Pick<
      ScheduledAutomation,
      | "name"
      | "prompt"
      | "projectId"
      | "modelSelection"
      | "runtimeMode"
      | "interactionMode"
      | "worktreePolicy"
      | "setupScriptPolicy"
      | "schedule"
      | "enabled"
      | "enabledAt"
      | "lastScheduledFor"
      | "lastThreadId"
      | "lastOutcome"
      | "updatedAt"
    >
  >,
) {
  return {
    name: changes.name ?? automation.name,
    prompt: changes.prompt ?? automation.prompt,
    projectId: changes.projectId ?? automation.projectId,
    modelSelection: changes.modelSelection ?? automation.modelSelection,
    runtimeMode: changes.runtimeMode ?? automation.runtimeMode,
    interactionMode: changes.interactionMode ?? automation.interactionMode,
    worktreePolicy: changes.worktreePolicy ?? automation.worktreePolicy,
    setupScriptPolicy: changes.setupScriptPolicy ?? automation.setupScriptPolicy,
    schedule: changes.schedule ?? automation.schedule,
    enabled: changes.enabled ?? automation.enabled,
    enabledAt: changes.enabledAt === undefined ? automation.enabledAt : changes.enabledAt,
    lastScheduledFor:
      changes.lastScheduledFor === undefined
        ? automation.lastScheduledFor
        : changes.lastScheduledFor,
    lastThreadId:
      changes.lastThreadId === undefined ? automation.lastThreadId : changes.lastThreadId,
    lastOutcome: changes.lastOutcome === undefined ? automation.lastOutcome : changes.lastOutcome,
    updatedAt: changes.updatedAt ?? automation.updatedAt,
  };
}

function definitionChanges(definition: ScheduledAutomationDefinition) {
  return {
    name: definition.name,
    prompt: definition.prompt,
    projectId: definition.projectId,
    modelSelection: definition.modelSelection,
    runtimeMode: definition.runtimeMode,
    interactionMode: definition.interactionMode,
    worktreePolicy: definition.worktreePolicy,
    setupScriptPolicy: definition.setupScriptPolicy,
    schedule: definition.schedule,
  };
}

function executionDefinition(definition: ScheduledAutomation | ScheduledAutomationDefinition) {
  return {
    name: definition.name,
    prompt: definition.prompt,
    projectId: definition.projectId,
    modelSelection: definition.modelSelection,
    runtimeMode: definition.runtimeMode,
    interactionMode: definition.interactionMode,
    worktreePolicy: definition.worktreePolicy,
    setupScriptPolicy: definition.setupScriptPolicy,
  };
}

function occurrenceResourceDefinition(
  definition: ScheduledAutomation | ScheduledAutomationDefinition,
) {
  return {
    projectId: definition.projectId,
    worktreePolicy: definition.worktreePolicy,
    setupScriptPolicy: definition.setupScriptPolicy,
  };
}

export const makeScheduledAutomationService = Effect.gen(function* () {
  const repository = yield* ScheduledAutomationRepository;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const scheduler = yield* ScheduledAutomationScheduler;
  const validation = yield* ScheduledAutomationValidation;

  const load = Effect.fn("ScheduledAutomationService.load")(function* (
    automationId: ScheduledAutomation["id"],
  ) {
    const found = yield* repository.get(automationId).pipe(mapInternalFailure("load"));
    if (Option.isNone(found)) {
      return yield* new ScheduledAutomationNotFoundError({ automationId });
    }
    return found.value;
  });

  const ensureExpectedRevision = (
    current: ScheduledAutomation,
    expectedRevision: number,
  ): Effect.Effect<void, ScheduledAutomationConflictError> =>
    current.revision === expectedRevision
      ? Effect.void
      : Effect.fail(new ScheduledAutomationConflictError({ current }));

  const validateLiveDefinition = validation.validateLiveDefinition;

  const view = Effect.fn("ScheduledAutomationService.view")(function* (
    automation: ScheduledAutomation,
  ) {
    const timestamp = yield* nowIso;
    const lastThread =
      automation.lastThreadId === null
        ? Option.none()
        : yield* projections
            .getThreadShellById(automation.lastThreadId)
            .pipe(mapInternalFailure("thread view"));

    let status: ScheduledAutomationView["status"];
    if (automation.lastOutcome === null) {
      status = "never-run";
    } else if (automation.lastOutcome.kind === "failed") {
      status = "failed";
    } else if (automation.lastOutcome.kind === "skipped-active") {
      status = "skipped-active";
    } else if (Option.isNone(lastThread)) {
      status = "thread-missing";
    } else if (lastThread.value.hasPendingApprovals || lastThread.value.hasPendingUserInput) {
      status = "blocked";
    } else if (isScheduledAutomationThreadActive(lastThread.value, { now: timestamp })) {
      status = "running";
    } else {
      switch (lastThread.value.latestTurn?.state) {
        case "completed":
          status = "completed";
          break;
        case "error":
          status = "failed";
          break;
        case "interrupted":
          status = "interrupted";
          break;
        default:
          status = automation.lastOutcome.kind === "starting" ? "starting" : "running";
      }
    }

    let nextScheduledFor: ScheduledAutomationView["nextScheduledFor"] = null;
    if (automation.enabled && automation.enabledAt !== null) {
      const boundary = scheduledAutomationPlanningBoundary({
        enabledAt: automation.enabledAt,
        lastScheduledFor: automation.lastScheduledFor,
      });
      if (Result.isFailure(boundary)) {
        return yield* new ScheduledAutomationInternalError({
          message: "Scheduled automation planning boundary could not be computed.",
        });
      }
      const next = nextScheduledAutomationOccurrence(automation.schedule, boundary.success);
      if (Result.isFailure(next)) {
        return yield* new ScheduledAutomationInternalError({
          message: "Scheduled automation next occurrence could not be computed.",
        });
      }
      nextScheduledFor = next.success;
    }

    return {
      automation,
      status,
      nextScheduledFor,
      lastThread: Option.getOrNull(lastThread),
    } satisfies ScheduledAutomationView;
  });

  const list: ScheduledAutomationServiceShape["list"] = () =>
    repository.list().pipe(
      mapInternalFailure("list"),
      Effect.flatMap((automations) => Effect.forEach(automations, view)),
    );

  const get: ScheduledAutomationServiceShape["get"] = (automationId) =>
    load(automationId).pipe(Effect.flatMap(view));

  const dispatch: ScheduledAutomationServiceShape["dispatch"] = Effect.fn(
    "ScheduledAutomationService.dispatch",
  )(function* (command) {
    const timestamp = yield* nowIso;
    switch (command.type) {
      case "scheduledAutomation.create": {
        const validated = validateScheduledAutomationDefinitionDraft(command.definition);
        if (Result.isFailure(validated)) return yield* validated.failure;
        const automation = yield* repository
          .create({ id: command.automationId, definition: validated.success, createdAt: timestamp })
          .pipe(mapRepositoryMutationFailure("create"));
        return { automation };
      }
      case "scheduledAutomation.update": {
        const current = yield* load(command.automationId);
        yield* ensureExpectedRevision(current, command.expectedRevision);
        const validated = validateScheduledAutomationDefinitionDraft(command.definition);
        if (Result.isFailure(validated)) return yield* validated.failure;
        if (
          current.lastOutcome?.kind === "starting" &&
          !Equal.equals(executionDefinition(current), executionDefinition(validated.success))
        ) {
          return yield* new ScheduledAutomationInvalidStateError({
            automationId: current.id,
            message: "Execution fields cannot change while an occurrence is starting.",
            current,
          });
        }
        if (
          current.lastOutcome?.kind === "failed" &&
          current.lastOutcome.code !== SCHEDULED_AUTOMATION_ABANDONED_CODE &&
          !Equal.equals(
            occurrenceResourceDefinition(current),
            occurrenceResourceDefinition(validated.success),
          )
        ) {
          return yield* new ScheduledAutomationInvalidStateError({
            automationId: current.id,
            message:
              "Project, worktree, and setup policies cannot change until the failed occurrence is abandoned.",
            current,
          });
        }
        if (current.enabled) yield* validateLiveDefinition(validated.success);
        const automation = yield* repository
          .compareAndSwapUpdate({
            automationId: command.automationId,
            expectedRevision: command.expectedRevision,
            replacement: replacement(current, {
              ...definitionChanges(validated.success),
              updatedAt: timestamp,
            }),
          })
          .pipe(mapRepositoryMutationFailure("update"));
        return { automation };
      }
      case "scheduledAutomation.enabled.set": {
        const current = yield* load(command.automationId);
        yield* ensureExpectedRevision(current, command.expectedRevision);
        if (command.enabled) yield* validateLiveDefinition(current);
        const enabledAt = command.enabled ? (current.enabledAt ?? timestamp) : null;
        const automation = yield* repository
          .compareAndSwapUpdate({
            automationId: command.automationId,
            expectedRevision: command.expectedRevision,
            replacement: replacement(current, {
              enabled: command.enabled,
              enabledAt,
              updatedAt: timestamp,
            }),
          })
          .pipe(mapRepositoryMutationFailure("enable"));
        return { automation };
      }
      case "scheduledAutomation.retry-last": {
        const current = yield* load(command.automationId);
        yield* ensureExpectedRevision(current, command.expectedRevision);
        if (current.lastOutcome?.kind !== "failed") {
          return yield* new ScheduledAutomationInvalidStateError({
            automationId: current.id,
            message: "Only a failed occurrence can be retried.",
            current,
          });
        }
        if (!current.lastOutcome.retryable) {
          return yield* new ScheduledAutomationInvalidStateError({
            automationId: current.id,
            message:
              current.lastOutcome.code === SCHEDULED_AUTOMATION_ABANDONED_CODE
                ? "The failed occurrence was abandoned and cannot be retried."
                : current.lastOutcome.code === SCHEDULED_AUTOMATION_BOOTSTRAP_PHASE_REJECTED_CODE
                  ? "A bootstrap phase was durably rejected. Disable and abandon this occurrence before correcting the definition."
                  : "This failure is non-retryable. Disable and abandon the occurrence before correcting the definition.",
            current,
          });
        }
        const automation = yield* scheduler
          .retry(command.automationId, command.expectedRevision)
          .pipe(
            Effect.mapError(
              (error): ManagementError =>
                error._tag === "PersistenceSqlError" || error._tag === "PersistenceDecodeError"
                  ? internalError("retry failed occurrence")(error)
                  : error,
            ),
          );
        return { automation };
      }
      case "scheduledAutomation.failed.abandon": {
        const current = yield* load(command.automationId);
        yield* ensureExpectedRevision(current, command.expectedRevision);
        if (current.lastOutcome?.kind !== "failed") {
          return yield* new ScheduledAutomationInvalidStateError({
            automationId: current.id,
            message: "Only a failed occurrence can be abandoned.",
            current,
          });
        }
        if (current.enabled) {
          return yield* new ScheduledAutomationInvalidStateError({
            automationId: current.id,
            message: "Disable the automation before abandoning its failed occurrence.",
            current,
          });
        }
        if (current.lastOutcome.code === SCHEDULED_AUTOMATION_ABANDONED_CODE) {
          return yield* new ScheduledAutomationInvalidStateError({
            automationId: current.id,
            message: "The failed occurrence is already abandoned.",
            current,
          });
        }
        const automation = yield* repository
          .compareAndSwapUpdate({
            automationId: command.automationId,
            expectedRevision: command.expectedRevision,
            replacement: replacement(current, {
              lastOutcome: {
                ...current.lastOutcome,
                observedAt: timestamp,
                code: SCHEDULED_AUTOMATION_ABANDONED_CODE,
                retryable: false,
                detail:
                  "The failed occurrence was abandoned. Its thread and worktree artifacts were retained.",
              },
              updatedAt: timestamp,
            }),
          })
          .pipe(mapRepositoryMutationFailure("abandon failed occurrence"));
        return { automation };
      }
      case "scheduledAutomation.delete": {
        const current = yield* load(command.automationId);
        yield* ensureExpectedRevision(current, command.expectedRevision);
        if (current.enabled) {
          return yield* new ScheduledAutomationInvalidStateError({
            automationId: current.id,
            message: "Disable the automation before deleting it.",
            current,
          });
        }
        yield* repository
          .compareAndSwapDelete({
            automationId: command.automationId,
            expectedRevision: command.expectedRevision,
          })
          .pipe(mapRepositoryMutationFailure("delete"));
        return { automation: null };
      }
    }
  });

  const acquireSubscription = Effect.gen(function* () {
    // Attach first, then read SQLite. A concurrent commit is therefore either
    // represented in the snapshot or queued as a following change (possibly both,
    // which is a harmless idempotent upsert for clients).
    const liveChanges = yield* repository.subscribe;
    const initial = yield* list();
    const live: Stream.Stream<ScheduledAutomationStreamItem, ScheduledAutomationInternalError> =
      liveChanges.pipe(
        Stream.mapEffect(
          (
            change,
          ): Effect.Effect<ScheduledAutomationStreamItem, ScheduledAutomationInternalError> => {
            if (change.kind === "removed") {
              return Effect.succeed({
                kind: "removed" as const,
                automationId: change.automationId,
              });
            }
            return view(change.automation).pipe(
              Effect.map((automation) => ({ kind: "upserted" as const, automation })),
            );
          },
        ),
      );
    const snapshotItem: ScheduledAutomationStreamItem = {
      kind: "snapshot",
      automations: initial,
    };
    const combined: Stream.Stream<ScheduledAutomationStreamItem, ScheduledAutomationInternalError> =
      Stream.concat(Stream.make(snapshotItem), live);
    return combined;
  });
  const subscribe: ScheduledAutomationServiceShape["subscribe"] = acquireSubscription.pipe(
    Effect.catch((error) => Effect.succeed(Stream.fail(error))),
  );

  return ScheduledAutomationService.of({ dispatch, list, get, subscribe });
});

function mapRepositoryMutationError(
  operation: string,
  error:
    | ScheduledAutomationRepositoryError
    | ScheduledAutomationNotFoundError
    | ScheduledAutomationConflictError,
): ManagementError {
  if (
    error._tag === "ScheduledAutomationNotFoundError" ||
    error._tag === "ScheduledAutomationConflictError"
  ) {
    return error;
  }
  return internalError(operation)(error);
}

function mapRepositoryMutationFailure(operation: string) {
  return <A, R>(
    effect: Effect.Effect<
      A,
      | ScheduledAutomationRepositoryError
      | ScheduledAutomationNotFoundError
      | ScheduledAutomationConflictError,
      R
    >,
  ): Effect.Effect<A, ManagementError, R> =>
    effect.pipe(
      Effect.tapError((error) =>
        error._tag === "ScheduledAutomationNotFoundError" ||
        error._tag === "ScheduledAutomationConflictError"
          ? Effect.void
          : Effect.logError(
              `Scheduled automation ${operation} failed.`,
              internalFailureAttributes(error),
            ),
      ),
      Effect.mapError((error) => mapRepositoryMutationError(operation, error)),
    );
}

export const ScheduledAutomationServiceLive = Layer.effect(
  ScheduledAutomationService,
  makeScheduledAutomationService,
);
