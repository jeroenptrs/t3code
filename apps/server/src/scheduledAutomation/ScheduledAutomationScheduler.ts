import {
  SCHEDULED_AUTOMATION_FAILURE_DETAIL_MAX_CHARS,
  ScheduledAutomationConflictError,
  type ScheduledAutomation,
  type ScheduledAutomationId,
  ScheduledAutomationInternalError,
  ScheduledAutomationInvalidStateError,
  ScheduledAutomationNotFoundError,
  type ScheduledAutomationOutcome,
  nextScheduledAutomationOccurrence,
  scheduledAutomationPlanningBoundary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ScheduledAutomationBootstrap } from "./ScheduledAutomationBootstrap.ts";
import {
  deriveScheduledAutomationOccurrenceIdentity,
  isScheduledAutomationThreadActive,
  planScheduledAutomationOccurrence,
} from "./ScheduledAutomationOccurrence.ts";
import {
  ScheduledAutomationRepository,
  type ScheduledAutomationRepositoryError,
  type ScheduledAutomationReplacement,
} from "./ScheduledAutomationRepository.ts";
import { ScheduledAutomationValidation } from "./ScheduledAutomationValidation.ts";

type SchedulerError =
  | ScheduledAutomationRepositoryError
  | ScheduledAutomationInternalError
  | ScheduledAutomationConflictError
  | ScheduledAutomationInvalidStateError
  | ScheduledAutomationNotFoundError;

export type ScheduledAutomationSchedulerStatus = "starting" | "running" | "failed";

export interface ScheduledAutomationSchedulerShape {
  readonly runOnce: Effect.Effect<void, SchedulerError>;
  readonly run: Effect.Effect<never, SchedulerError>;
  readonly retry: (
    automationId: ScheduledAutomationId,
    expectedRevision: number,
  ) => Effect.Effect<ScheduledAutomation, SchedulerError>;
  readonly health: Effect.Effect<ScheduledAutomationSchedulerStatus>;
  readonly subscribeHealth: Effect.Effect<
    Stream.Stream<ScheduledAutomationSchedulerStatus>,
    never,
    import("effect/Scope").Scope
  >;
}

export class ScheduledAutomationScheduler extends Context.Service<
  ScheduledAutomationScheduler,
  ScheduledAutomationSchedulerShape
>()("t3/scheduledAutomation/ScheduledAutomationScheduler") {}

export interface ScheduledAutomationSchedulerOptions {
  readonly onCycleStarted?: Effect.Effect<void>;
  readonly onCycleCompleted?: (result: { readonly hadFailures: boolean }) => Effect.Effect<void>;
  readonly onAutomationEvaluated?: (automationId: ScheduledAutomationId) => Effect.Effect<void>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const MAX_COORDINATOR_RECHECK_MS = 60_000;
const MAX_COORDINATOR_FAILURE_BACKOFF_MS = 60_000;

function replacement(
  automation: ScheduledAutomation,
  input: {
    readonly lastOutcome: ScheduledAutomationOutcome;
    readonly updatedAt: string;
  },
): ScheduledAutomationReplacement {
  return {
    name: automation.name,
    prompt: automation.prompt,
    projectId: automation.projectId,
    modelSelection: automation.modelSelection,
    runtimeMode: automation.runtimeMode,
    interactionMode: automation.interactionMode,
    worktreePolicy: automation.worktreePolicy,
    setupScriptPolicy: automation.setupScriptPolicy,
    schedule: automation.schedule,
    enabled: automation.enabled,
    enabledAt: automation.enabledAt,
    lastScheduledFor: automation.lastScheduledFor,
    lastThreadId: automation.lastThreadId,
    lastOutcome: input.lastOutcome,
    updatedAt: input.updatedAt,
  };
}

function boundedFailureDetail(detail: string, prompt: string): string {
  const normalizeWhitespace = (value: string) => value.trim().replaceAll(/\s+/g, " ");
  const normalizedPrompt = normalizeWhitespace(prompt);
  const normalizedDetail = normalizeWhitespace(detail);
  const normalized =
    normalizedPrompt.length > 0
      ? normalizedDetail.replaceAll(normalizedPrompt, "[redacted]")
      : normalizedDetail;
  const bounded = normalized.slice(0, SCHEDULED_AUTOMATION_FAILURE_DETAIL_MAX_CHARS);
  return bounded.length > 0 ? bounded : "Scheduled automation execution failed.";
}

function boundedFailureCode(code: string): string {
  const normalized = code.trim();
  return normalized.length <= 80 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(normalized)
    ? normalized
    : "bootstrap.failed";
}

function internalError(operation: string): ScheduledAutomationInternalError {
  return new ScheduledAutomationInternalError({
    message: `Scheduled automation ${operation} failed.`,
  });
}

function schedulerFailureAttributes(cause: unknown): Readonly<Record<string, unknown>> {
  if (typeof cause !== "object" || cause === null) return { errorType: typeof cause };
  const error = cause as Record<string, unknown>;
  return {
    ...(typeof error._tag === "string" ? { errorTag: error._tag } : {}),
    ...("operation" in error && typeof error.operation === "string"
      ? { operation: error.operation }
      : {}),
    ...("automationId" in error ? { automationId: error.automationId } : {}),
  };
}

function schedulerCauseAttributes(cause: Cause.Cause<unknown>): Readonly<Record<string, unknown>> {
  const failure = cause.reasons.find(Cause.isFailReason);
  const defect = cause.reasons.find(Cause.isDieReason);
  return {
    reasonCount: cause.reasons.length,
    failureCount: cause.reasons.filter(Cause.isFailReason).length,
    defectCount: cause.reasons.filter(Cause.isDieReason).length,
    interruptionCount: cause.reasons.filter(Cause.isInterruptReason).length,
    ...(failure === undefined ? {} : schedulerFailureAttributes(failure.error)),
    ...(defect === undefined
      ? {}
      : {
          defectType: typeof defect.defect,
          defectTag: schedulerFailureAttributes(defect.defect).errorTag,
        }),
  };
}

export const makeScheduledAutomationScheduler = (
  options: ScheduledAutomationSchedulerOptions = {},
) =>
  Effect.gen(function* () {
    const repository = yield* ScheduledAutomationRepository;
    const projections = yield* ProjectionSnapshotQuery;
    const receipts = yield* OrchestrationCommandReceiptRepository;
    const bootstrap = yield* ScheduledAutomationBootstrap;
    const validation = yield* ScheduledAutomationValidation;
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    interface LockEntry {
      readonly semaphore: Semaphore.Semaphore;
      readonly users: number;
    }
    const locks = yield* Ref.make<ReadonlyMap<ScheduledAutomationId, LockEntry>>(new Map());
    const health = yield* Ref.make<ScheduledAutomationSchedulerStatus>("starting");
    const healthChanges = yield* PubSub.sliding<ScheduledAutomationSchedulerStatus>(1);
    yield* Effect.addFinalizer(() => PubSub.shutdown(healthChanges));
    const setHealth = (status: ScheduledAutomationSchedulerStatus) =>
      Ref.set(health, status).pipe(
        Effect.andThen(PubSub.publish(healthChanges, status)),
        Effect.asVoid,
      );

    const acquireLock: (automationId: ScheduledAutomationId) => Effect.Effect<Semaphore.Semaphore> =
      Effect.fn("ScheduledAutomationScheduler.acquireLock")(function* (
        automationId: ScheduledAutomationId,
      ) {
        const current = (yield* Ref.get(locks)).get(automationId);
        if (current !== undefined) {
          return yield* Ref.modify(locks, (entries) => {
            const existing = entries.get(automationId);
            if (existing === undefined) return [Option.none(), entries] as const;
            const next = new Map(entries);
            next.set(automationId, { ...existing, users: existing.users + 1 });
            return [Option.some(existing.semaphore), next] as const;
          }).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => acquireLock(automationId),
                onSome: Effect.succeed,
              }),
            ),
          );
        }
        const created = yield* Semaphore.make(1);
        return yield* Ref.modify(locks, (current) => {
          const existing = current.get(automationId);
          if (existing !== undefined) {
            const next = new Map(current);
            next.set(automationId, { ...existing, users: existing.users + 1 });
            return [existing.semaphore, next] as const;
          }
          const next = new Map(current);
          next.set(automationId, { semaphore: created, users: 1 });
          return [created, next] as const;
        });
      });

    const releaseLock = (automationId: ScheduledAutomationId, semaphore: Semaphore.Semaphore) =>
      Ref.update(locks, (current) => {
        const entry = current.get(automationId);
        if (entry === undefined || entry.semaphore !== semaphore) return current;
        const next = new Map(current);
        if (entry.users === 1) next.delete(automationId);
        else next.set(automationId, { ...entry, users: entry.users - 1 });
        return next;
      });

    const withAutomationLock = <A, E, R>(
      automationId: ScheduledAutomationId,
      effect: Effect.Effect<A, E, R>,
    ) =>
      Effect.acquireUseRelease(
        acquireLock(automationId),
        (semaphore) => semaphore.withPermits(1)(effect),
        (semaphore) => releaseLock(automationId, semaphore),
      );

    const updateOutcome = Effect.fn("ScheduledAutomationScheduler.updateOutcome")(function* (
      current: ScheduledAutomation,
      outcome: ScheduledAutomationOutcome,
      updatedAt: string,
    ) {
      return yield* repository.compareAndSwapUpdate({
        automationId: current.id,
        expectedRevision: current.revision,
        replacement: replacement(current, { lastOutcome: outcome, updatedAt }),
      });
    });

    const persistFailed = Effect.fn("ScheduledAutomationScheduler.persistFailed")(function* (
      current: ScheduledAutomation,
      input: { readonly code: string; readonly detail: string; readonly retryable: boolean },
    ) {
      if (current.lastOutcome?.kind !== "starting") return current;
      const observedAt = yield* nowIso;
      const failed: ScheduledAutomationOutcome = {
        ...current.lastOutcome,
        kind: "failed",
        observedAt,
        code: boundedFailureCode(input.code),
        detail: boundedFailureDetail(input.detail, current.prompt),
        retryable: input.retryable,
      };
      const updated = yield* updateOutcome(current, failed, observedAt);
      yield* Effect.logWarning("Scheduled automation occurrence failed", {
        automationId: current.id,
        scheduledFor: failed.scheduledFor,
        threadId: current.lastThreadId,
        code: failed.code,
        retryable: failed.retryable,
      });
      return updated;
    });

    const reconcileStartingUnlocked = Effect.fn(
      "ScheduledAutomationScheduler.reconcileStartingUnlocked",
    )(function* (current: ScheduledAutomation) {
      if (
        current.lastOutcome?.kind !== "starting" ||
        current.lastScheduledFor === null ||
        current.lastThreadId === null
      ) {
        return current;
      }
      const identity = deriveScheduledAutomationOccurrenceIdentity(
        {
          automationId: current.id,
          scheduledFor: current.lastScheduledFor,
          worktreesDir: config.worktreesDir,
        },
        path,
      );
      if (Result.isFailure(identity)) {
        return yield* persistFailed(current, {
          code: "automation.identity-invalid",
          detail: identity.failure.message,
          retryable: false,
        });
      }

      const receipt = yield* receipts
        .getByCommandId({ commandId: identity.success.phaseCommandIds.startTurn })
        .pipe(Effect.mapError(() => internalError("start receipt inspection")));
      if (Option.isSome(receipt)) {
        if (
          receipt.value.status === "accepted" &&
          receipt.value.aggregateKind === "thread" &&
          receipt.value.aggregateId === current.lastThreadId
        ) {
          const thread = yield* projections
            .getThreadDetailById(current.lastThreadId)
            .pipe(Effect.mapError(() => internalError("start projection inspection")));
          const message = Option.isSome(thread)
            ? thread.value.messages.find((candidate) => candidate.id === identity.success.messageId)
            : undefined;
          if (
            message !== undefined &&
            message.role === "user" &&
            message.text === current.prompt &&
            (message.attachments?.length ?? 0) === 0
          ) {
            const observedAt = yield* nowIso;
            const started: ScheduledAutomationOutcome = {
              ...current.lastOutcome,
              kind: "started",
              observedAt,
            };
            const updated = yield* updateOutcome(current, started, observedAt);
            yield* Effect.logInfo("Scheduled automation start reconciled", {
              automationId: current.id,
              scheduledFor: started.scheduledFor,
              threadId: current.lastThreadId,
            });
            return updated;
          }
        }
      }

      if (Option.isNone(receipt)) {
        const validationExit = yield* Effect.exit(validation.validateLiveDefinition(current));
        if (validationExit._tag === "Failure") {
          return yield* persistFailed(current, {
            code: "automation.configuration-unavailable",
            detail: "The scheduled automation configuration is currently unavailable.",
            retryable: true,
          });
        }
      }

      const dispatched = yield* Effect.result(
        bootstrap.dispatch(current, current.lastScheduledFor),
      );
      if (Result.isFailure(dispatched)) {
        return yield* persistFailed(current, {
          code: dispatched.failure.code ?? "bootstrap.failed",
          detail: dispatched.failure.message,
          retryable: dispatched.failure.retryable ?? true,
        });
      }

      const observedAt = yield* nowIso;
      const started: ScheduledAutomationOutcome = {
        ...current.lastOutcome,
        kind: "started",
        observedAt,
      };
      const updated = yield* updateOutcome(current, started, observedAt);
      yield* Effect.logInfo("Scheduled automation occurrence started", {
        automationId: current.id,
        scheduledFor: started.scheduledFor,
        threadId: current.lastThreadId,
      });
      return updated;
    });

    const reconcileStarting = Effect.fn("ScheduledAutomationScheduler.reconcileStarting")(
      function* (automationId: ScheduledAutomationId) {
        return yield* withAutomationLock(
          automationId,
          Effect.gen(function* () {
            const current = yield* repository.get(automationId);
            if (Option.isNone(current)) return Option.none();
            return Option.some(yield* reconcileStartingUnlocked(current.value));
          }),
        );
      },
    );

    const evaluateDue = Effect.fn("ScheduledAutomationScheduler.evaluateDue")(function* (
      automationId: ScheduledAutomationId,
    ) {
      yield* withAutomationLock(
        automationId,
        Effect.gen(function* () {
          const loaded = yield* repository.get(automationId);
          if (Option.isNone(loaded)) return;
          let current = loaded.value;
          if (current.lastOutcome?.kind === "starting") {
            yield* reconcileStartingUnlocked(current);
            return;
          }

          const observedAt = yield* nowIso;
          const plan = yield* planScheduledAutomationOccurrence(current, observedAt);
          if (Result.isFailure(plan)) {
            yield* Effect.logWarning("Scheduled automation occurrence planning failed", {
              automationId: current.id,
              field: plan.failure.field,
            });
            return yield* internalError("occurrence planning");
          }
          if (Option.isNone(plan.success)) return;
          yield* Effect.logDebug("Scheduled automation occurrence planned", {
            automationId: current.id,
            observedAt,
            scheduledFor: plan.success.value.scheduledFor,
            coalescedCount: plan.success.value.coalescedCount,
          });

          if (current.lastThreadId !== null) {
            const previous = yield* projections
              .getThreadShellById(current.lastThreadId)
              .pipe(Effect.mapError(() => internalError("active thread inspection")));
            if (
              Option.isSome(previous) &&
              isScheduledAutomationThreadActive(previous.value, { now: observedAt })
            ) {
              const skipped: ScheduledAutomationOutcome = {
                kind: "skipped-active",
                scheduledFor: plan.success.value.scheduledFor,
                observedAt,
                coalescedCount: plan.success.value.coalescedCount,
                previousThreadId: current.lastThreadId,
              };
              current = yield* repository.claimOccurrence({
                automationId: current.id,
                expectedRevision: current.revision,
                scheduledFor: skipped.scheduledFor,
                lastThreadId: current.lastThreadId,
                lastOutcome: skipped,
                updatedAt: observedAt,
              });
              yield* Effect.logInfo("Scheduled automation occurrence skipped", {
                automationId: current.id,
                scheduledFor: skipped.scheduledFor,
                previousThreadId: skipped.previousThreadId,
                coalescedCount: skipped.coalescedCount,
              });
              return;
            }
          }

          const identity = deriveScheduledAutomationOccurrenceIdentity(
            {
              automationId: current.id,
              scheduledFor: plan.success.value.scheduledFor,
              worktreesDir: config.worktreesDir,
            },
            path,
          );
          if (Result.isFailure(identity)) {
            yield* Effect.logWarning("Scheduled automation occurrence identity failed", {
              automationId: current.id,
              scheduledFor: plan.success.value.scheduledFor,
            });
            return yield* internalError("occurrence identity derivation");
          }
          const starting: ScheduledAutomationOutcome = {
            kind: "starting",
            scheduledFor: plan.success.value.scheduledFor,
            observedAt,
            coalescedCount: plan.success.value.coalescedCount,
          };
          current = yield* repository.claimOccurrence({
            automationId: current.id,
            expectedRevision: current.revision,
            scheduledFor: starting.scheduledFor,
            lastThreadId: identity.success.threadId,
            lastOutcome: starting,
            updatedAt: observedAt,
          });
          yield* Effect.logInfo("Scheduled automation occurrence claimed", {
            automationId: current.id,
            scheduledFor: starting.scheduledFor,
            threadId: current.lastThreadId,
            coalescedCount: starting.coalescedCount,
          });
          yield* reconcileStartingUnlocked(current);
        }),
      );
    });

    const runCycle = Effect.gen(function* () {
      yield* options.onCycleStarted ?? Effect.void;
      let hadFailures = false;
      const failedReconciliations = new Set<ScheduledAutomationId>();
      const initialInspection = yield* repository.inspect();
      if (initialInspection.malformedDefinitionCount > 0) {
        yield* Effect.logWarning("Malformed scheduled automation definitions were skipped", {
          malformedDefinitionCount: initialInspection.malformedDefinitionCount,
        });
      }
      const automations = initialInspection.automations;
      for (const automation of automations) {
        if (automation.lastOutcome?.kind === "starting") {
          const result = yield* Effect.result(reconcileStarting(automation.id));
          if (Result.isFailure(result)) {
            hadFailures = true;
            failedReconciliations.add(automation.id);
            yield* Effect.logError("Scheduled automation reconciliation failed", {
              ...schedulerFailureAttributes(result.failure),
              automationId: automation.id,
            });
          }
        }
      }
      const refreshed = (yield* repository.inspect()).automations.filter(
        (automation) =>
          (automation.enabled || automation.lastOutcome?.kind === "starting") &&
          !failedReconciliations.has(automation.id),
      );
      const evaluations = yield* Effect.forEach(
        refreshed,
        (automation) =>
          (options.onAutomationEvaluated?.(automation.id) ?? Effect.void).pipe(
            Effect.andThen(evaluateDue(automation.id)),
            Effect.result,
            Effect.map((result) => ({ automationId: automation.id, result })),
          ),
        {
          concurrency: 8,
        },
      );
      for (const evaluation of evaluations) {
        if (Result.isSuccess(evaluation.result)) continue;
        hadFailures = true;
        yield* Effect.logWarning(
          "Scheduled automation evaluation deferred",
          schedulerFailureAttributes(evaluation.result.failure),
        ).pipe(Effect.annotateLogs({ automationId: evaluation.automationId }));
      }
      yield* options.onCycleCompleted?.({ hadFailures }) ?? Effect.void;
      return { hadFailures } as const;
    });

    const runOnce = runCycle.pipe(Effect.asVoid);

    const nextDelay = Effect.gen(function* () {
      const timestamp = yield* nowIso;
      const nowMs = Date.parse(timestamp);
      const automations = (yield* repository.inspect()).automations;
      let nearest = Number.POSITIVE_INFINITY;
      for (const automation of automations) {
        if (automation.lastOutcome?.kind === "starting") return 0;
        if (!automation.enabled || automation.enabledAt === null) continue;
        const boundary = scheduledAutomationPlanningBoundary({
          enabledAt: automation.enabledAt,
          lastScheduledFor: automation.lastScheduledFor,
        });
        if (Result.isFailure(boundary)) continue;
        const next = nextScheduledAutomationOccurrence(automation.schedule, boundary.success);
        if (Result.isSuccess(next)) {
          const nextMs = Date.parse(next.success);
          if (nextMs <= nowMs) return 0;
          nearest = Math.min(nearest, nextMs);
        }
      }
      return Number.isFinite(nearest) ? Math.max(0, nearest - nowMs) : null;
    });

    const coordinator = Effect.scoped(
      Effect.gen(function* () {
        const signal = yield* Queue.sliding<void>(1);
        const changes = yield* repository.subscribe;
        yield* changes.pipe(
          Stream.runForEach(() => Queue.offer(signal, undefined).pipe(Effect.asVoid)),
          Effect.forkScoped,
        );
        let consecutiveFailureCycles = 0;
        while (true) {
          const cycle = yield* Effect.result(runCycle);
          const hadFailures = Result.isFailure(cycle) || cycle.success.hadFailures;
          if (Result.isFailure(cycle)) {
            yield* Effect.logError(
              "Scheduled automation coordinator cycle failed",
              schedulerFailureAttributes(cycle.failure),
            );
          }
          consecutiveFailureCycles = hadFailures ? consecutiveFailureCycles + 1 : 0;
          const delay = yield* Effect.result(nextDelay);
          if (Result.isFailure(delay)) {
            yield* Effect.logError(
              "Scheduled automation coordinator wake planning failed",
              schedulerFailureAttributes(delay.failure),
            );
          }
          const failureBackoff = Math.min(
            MAX_COORDINATOR_FAILURE_BACKOFF_MS,
            1_000 * 2 ** Math.max(0, consecutiveFailureCycles - 1),
          );
          const scheduledDelay = Result.isFailure(delay)
            ? MAX_COORDINATOR_RECHECK_MS
            : (delay.success ?? MAX_COORDINATOR_RECHECK_MS);
          const sleepFor = hadFailures
            ? failureBackoff
            : Math.min(MAX_COORDINATOR_RECHECK_MS, scheduledDelay);
          yield* Effect.raceFirst(Queue.take(signal), Effect.sleep(sleepFor));
        }
      }),
    );

    const retry: ScheduledAutomationSchedulerShape["retry"] = Effect.fn(
      "ScheduledAutomationScheduler.retry",
    )(function* (automationId, expectedRevision) {
      return yield* withAutomationLock(
        automationId,
        Effect.gen(function* () {
          const loaded = yield* repository.get(automationId);
          if (Option.isNone(loaded)) {
            return yield* new ScheduledAutomationNotFoundError({ automationId });
          }
          const current = loaded.value;
          if (current.revision !== expectedRevision) {
            return yield* new ScheduledAutomationConflictError({ current });
          }
          if (current.lastOutcome?.kind !== "failed" || current.lastScheduledFor === null) {
            return yield* new ScheduledAutomationInvalidStateError({
              automationId,
              message: "Only a failed occurrence can be retried.",
              current,
            });
          }
          if (!current.lastOutcome.retryable) {
            return yield* new ScheduledAutomationInvalidStateError({
              automationId,
              message:
                "This failure is non-retryable. Disable and abandon the occurrence before correcting the definition.",
              current,
            });
          }
          const observedAt = yield* nowIso;
          const starting: ScheduledAutomationOutcome = {
            kind: "starting",
            scheduledFor: current.lastOutcome.scheduledFor,
            observedAt,
            coalescedCount: current.lastOutcome.coalescedCount,
          };
          const claimed = yield* updateOutcome(current, starting, observedAt);
          return yield* reconcileStartingUnlocked(claimed);
        }),
      );
    });

    const run = setHealth("running").pipe(
      Effect.andThen(coordinator),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : setHealth("failed").pipe(Effect.andThen(Effect.failCause(cause))),
      ),
    );
    const subscribeHealth = PubSub.subscribe(healthChanges).pipe(
      Effect.map(Stream.fromSubscription),
    );

    return ScheduledAutomationScheduler.of({
      runOnce,
      run,
      retry,
      health: Ref.get(health),
      subscribeHealth,
    });
  });

export const layerWithOptions = (options: ScheduledAutomationSchedulerOptions = {}) =>
  Layer.effect(ScheduledAutomationScheduler, makeScheduledAutomationScheduler(options));

export const layer = layerWithOptions();

export const launch = Effect.flatMap(ScheduledAutomationScheduler, (scheduler) =>
  scheduler.run.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logError(
            "Scheduled automation coordinator stopped",
            schedulerCauseAttributes(cause),
          ),
    ),
    Effect.forkScoped,
    Effect.asVoid,
  ),
);
