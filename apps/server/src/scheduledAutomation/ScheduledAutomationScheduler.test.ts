import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ScheduledAutomationDefinition,
  ScheduledAutomationId,
  ScheduledAutomationValidationError,
  ThreadId,
  type OrchestrationThreadShell,
  type ScheduledAutomation,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { ScheduledAutomationBootstrap } from "./ScheduledAutomationBootstrap.ts";
import {
  ScheduledAutomationRepository,
  ScheduledAutomationRepositoryLive,
} from "./ScheduledAutomationRepository.ts";
import {
  ScheduledAutomationScheduler,
  launch as launchScheduledAutomationCoordinator,
  layerWithOptions as scheduledAutomationSchedulerLayer,
  type ScheduledAutomationSchedulerOptions,
} from "./ScheduledAutomationScheduler.ts";
import { ScheduledAutomationValidation } from "./ScheduledAutomationValidation.ts";

const automationId = ScheduledAutomationId.make("scheduler-acceptance");
const definition = Schema.decodeUnknownSync(ScheduledAutomationDefinition)({
  name: "Scheduler acceptance",
  prompt: "Inspect the workspace.",
  projectId: "project-1",
  modelSelection: { instanceId: "codex", model: "gpt-5.6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  worktreePolicy: { kind: "current" },
  setupScriptPolicy: "skip",
  schedule: { cron: "* * * * *", timeZone: "UTC", misfirePolicy: "latest-only" },
});

interface HarnessState {
  readonly dispatched: Array<{
    readonly automation: ScheduledAutomation;
    readonly scheduledFor: string;
  }>;
  shell: OrchestrationThreadShell | null;
  receipt: Option.Option<{
    readonly commandId: string;
    readonly aggregateKind: "thread";
    readonly aggregateId: ThreadId;
    readonly acceptedAt: string;
    readonly resultSequence: number;
    readonly status: "accepted";
    readonly error: null;
  }>;
  bootstrapFailure: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
  started: Deferred.Deferred<void> | null;
  validationFailure: boolean;
  receiptFailure: boolean;
  receiptAttempts: number;
  receiptAttempted: Deferred.Deferred<number> | null;
}

function harnessLayer(
  state: HarnessState,
  schedulerOptions: ScheduledAutomationSchedulerOptions = {},
) {
  const dependencies = Layer.mergeAll(
    Layer.succeed(ServerConfig, { worktreesDir: "/tmp/t3-worktrees" } as ServerConfig["Service"]),
    Layer.succeed(ProjectionSnapshotQuery, {
      getThreadShellById: () => Effect.succeed(Option.fromNullishOr(state.shell)),
    } as unknown as ProjectionSnapshotQuery["Service"]),
    Layer.succeed(OrchestrationCommandReceiptRepository, {
      upsert: () => Effect.void,
      getByCommandId: () =>
        Effect.sync(() => {
          state.receiptAttempts += 1;
          return state.receiptAttempts;
        }).pipe(
          Effect.tap((attempt) =>
            state.receiptAttempted === null
              ? Effect.void
              : Deferred.succeed(state.receiptAttempted, attempt),
          ),
          Effect.flatMap(() =>
            state.receiptFailure
              ? Effect.fail(
                  new PersistenceSqlError({
                    operation: "test receipt lookup",
                    detail: "persistent test failure",
                  }),
                )
              : Effect.succeed(state.receipt),
          ),
        ),
    } as unknown as OrchestrationCommandReceiptRepository["Service"]),
    Layer.succeed(ScheduledAutomationBootstrap, {
      dispatch: (automation: ScheduledAutomation, scheduledFor: string) =>
        Effect.sync(() => state.dispatched.push({ automation, scheduledFor })).pipe(
          Effect.andThen(
            state.started === null ? Effect.void : Deferred.succeed(state.started, undefined),
          ),
          Effect.andThen(
            state.bootstrapFailure === null
              ? Effect.succeed({ sequence: 1 })
              : Effect.fail(state.bootstrapFailure),
          ),
        ),
    } as unknown as ScheduledAutomationBootstrap["Service"]),
    Layer.succeed(ScheduledAutomationValidation, {
      validateLiveDefinition: () =>
        state.validationFailure
          ? Effect.fail(
              new ScheduledAutomationValidationError({
                field: "modelSelection",
                message: "The selected provider is unavailable.",
              }),
            )
          : Effect.void,
    }),
    NodeServices.layer,
  );
  return scheduledAutomationSchedulerLayer(schedulerOptions).pipe(
    Layer.provideMerge(ScheduledAutomationRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(dependencies),
  );
}

function state(): HarnessState {
  return {
    dispatched: [],
    shell: null,
    receipt: Option.none(),
    bootstrapFailure: null,
    started: null,
    validationFailure: false,
    receiptFailure: false,
    receiptAttempts: 0,
    receiptAttempted: null,
  };
}

function renderLogValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(renderLogValue).join(" ");
  if (typeof value === "object" && value !== null) {
    return Object.entries(value)
      .flatMap(([key, entry]) => [key, renderLogValue(entry)])
      .join(" ");
  }
  return String(value);
}

const enable = Effect.fn("ScheduledAutomationSchedulerTest.enable")(function* (
  repository: ScheduledAutomationRepository["Service"],
  enabledAt: string,
) {
  const created = yield* repository.create({
    id: automationId,
    definition,
    createdAt: enabledAt,
  });
  return yield* repository.compareAndSwapUpdate({
    automationId,
    expectedRevision: created.revision,
    replacement: {
      ...definition,
      enabled: true,
      enabledAt,
      lastScheduledFor: null,
      lastThreadId: null,
      lastOutcome: null,
      updatedAt: enabledAt,
    },
  });
});

it.effect("the production launcher forks exactly one coordinator fiber", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const launches = yield* Ref.make(0);
      const run = Ref.update(launches, (count) => count + 1).pipe(Effect.andThen(Effect.never));
      yield* launchScheduledAutomationCoordinator.pipe(
        Effect.provideService(ScheduledAutomationScheduler, {
          run,
          runOnce: Effect.void,
          retry: () => Effect.die("unused test retry"),
          health: Effect.succeed("running" as const),
          subscribeHealth: Effect.succeed(Stream.empty),
        }),
      );
      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(launches), 1);
    }),
  ),
);

it.effect("a coordinator startup defect is isolated from unrelated server work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const logRecords: Array<string> = [];
      const logger = Logger.make<unknown, void>((options) => {
        const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
        const messages = Array.isArray(options.message) ? options.message : [options.message];
        logRecords.push(
          [
            ...messages.map(renderLogValue),
            ...Object.entries(annotations).flatMap(([key, value]) => [key, renderLogValue(value)]),
          ].join(" "),
        );
      });
      yield* launchScheduledAutomationCoordinator.pipe(
        Effect.provideService(ScheduledAutomationScheduler, {
          run: Effect.die("scheduler startup failed"),
          runOnce: Effect.void,
          retry: () => Effect.die("unused test retry"),
          health: Effect.succeed("failed" as const),
          subscribeHealth: Effect.succeed(Stream.empty),
        }),
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      );
      yield* Effect.yieldNow;
      const logged = logRecords.join(" ");
      assert.include(logged, "Scheduled automation coordinator stopped");
      assert.include(logged, "defectCount 1");
      assert.include(logged, "defectType string");
    }),
  ),
);

it.effect("claims and starts a due occurrence exactly once across duplicate evaluations", () => {
  const testState = state();
  return Effect.gen(function* () {
    const repository = yield* ScheduledAutomationRepository;
    const scheduler = yield* ScheduledAutomationScheduler;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM local_scheduled_automations_v1`;
    yield* enable(repository, "2026-08-04T10:00:00.000Z");
    yield* TestClock.setTime(Date.parse("2026-08-04T10:01:00.000Z"));

    yield* Effect.all([scheduler.runOnce, scheduler.runOnce], { concurrency: "unbounded" });
    const afterFirst = Option.getOrThrow(yield* repository.get(automationId));
    yield* scheduler.runOnce;
    const afterDuplicate = Option.getOrThrow(yield* repository.get(automationId));

    assert.equal(testState.dispatched.length, 1);
    assert.equal(afterFirst.revision, 4);
    assert.deepStrictEqual(afterDuplicate, afterFirst);
    assert.equal(afterFirst.lastScheduledFor, "2026-08-04T10:01:00.000Z");
    assert.equal(afterFirst.lastOutcome?.kind, "started");
    const retryError = yield* Effect.flip(scheduler.retry(automationId, afterFirst.revision));
    assert.equal(retryError._tag, "ScheduledAutomationInvalidStateError");
  }).pipe(Effect.provide(harnessLayer(testState)));
});

it.effect("continues scheduling valid definitions when another stored row is malformed", () => {
  const testState = state();
  return Effect.gen(function* () {
    const repository = yield* ScheduledAutomationRepository;
    const scheduler = yield* ScheduledAutomationScheduler;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM local_scheduled_automations_v1`;
    yield* sql`
      INSERT INTO local_scheduled_automations_v1 (
        id, schema_version, revision, definition_json, enabled, enabled_at,
        last_scheduled_for, last_thread_id, last_outcome_json, created_at, updated_at
      ) VALUES (
        'malformed-neighbor', 1, 1, '{"prompt":"must-not-be-logged"}', 1,
        '2026-08-04T10:00:00.000Z', NULL, NULL, NULL,
        '2026-08-04T10:00:00.000Z', '2026-08-04T10:00:00.000Z'
      )
    `;
    yield* enable(repository, "2026-08-04T10:00:00.000Z");
    yield* TestClock.setTime(Date.parse("2026-08-04T10:01:00.000Z"));

    yield* scheduler.runOnce;

    const valid = Option.getOrThrow(yield* repository.get(automationId));
    assert.equal(testState.dispatched.length, 1);
    assert.equal(valid.lastScheduledFor, "2026-08-04T10:01:00.000Z");
    assert.equal(valid.lastOutcome?.kind, "started");
  }).pipe(Effect.provide(harnessLayer(testState)), Effect.scoped);
});

it.effect("coalesces missed instants into one claimed run with a truthful count", () => {
  const testState = state();
  return Effect.gen(function* () {
    const repository = yield* ScheduledAutomationRepository;
    const scheduler = yield* ScheduledAutomationScheduler;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM local_scheduled_automations_v1`;
    yield* enable(repository, "2026-08-04T10:00:00.000Z");
    yield* TestClock.setTime(Date.parse("2026-08-04T10:10:00.000Z"));

    yield* scheduler.runOnce;
    const row = Option.getOrThrow(yield* repository.get(automationId));
    assert.equal(testState.dispatched.length, 1);
    assert.equal(row.lastScheduledFor, "2026-08-04T10:10:00.000Z");
    assert.equal(row.lastOutcome?.coalescedCount, 9);
  }).pipe(Effect.provide(harnessLayer(testState)));
});

it.effect("disabled time is never claimed or replayed after activation", () => {
  const testState = state();
  return Effect.gen(function* () {
    const repository = yield* ScheduledAutomationRepository;
    const scheduler = yield* ScheduledAutomationScheduler;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM local_scheduled_automations_v1`;
    const created = yield* repository.create({
      id: automationId,
      definition,
      createdAt: "2026-08-04T10:00:00.000Z",
    });
    yield* TestClock.setTime(Date.parse("2026-08-04T10:05:00.000Z"));
    yield* scheduler.runOnce;
    assert.equal(testState.dispatched.length, 0);

    yield* repository.compareAndSwapUpdate({
      automationId,
      expectedRevision: created.revision,
      replacement: {
        ...definition,
        enabled: true,
        enabledAt: "2026-08-04T10:05:00.000Z",
        lastScheduledFor: null,
        lastThreadId: null,
        lastOutcome: null,
        updatedAt: "2026-08-04T10:05:00.000Z",
      },
    });
    yield* TestClock.setTime(Date.parse("2026-08-04T10:05:59.000Z"));
    yield* scheduler.runOnce;
    assert.equal(testState.dispatched.length, 0);

    yield* TestClock.setTime(Date.parse("2026-08-04T10:06:00.000Z"));
    yield* scheduler.runOnce;
    const row = Option.getOrThrow(yield* repository.get(automationId));
    assert.equal(testState.dispatched.length, 1);
    assert.equal(row.lastScheduledFor, "2026-08-04T10:06:00.000Z");
    assert.equal(row.lastOutcome?.coalescedCount, 0);
  }).pipe(Effect.provide(harnessLayer(testState)));
});

it.effect("coalesces 10,000 missed instants without a backlog dispatch loop", () => {
  const testState = state();
  return Effect.gen(function* () {
    const repository = yield* ScheduledAutomationRepository;
    const scheduler = yield* ScheduledAutomationScheduler;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM local_scheduled_automations_v1`;
    yield* enable(repository, "2026-01-01T00:00:00.000Z");
    yield* TestClock.setTime(Date.parse("2026-01-07T22:40:00.000Z"));

    yield* scheduler.runOnce;
    const row = Option.getOrThrow(yield* repository.get(automationId));
    assert.equal(testState.dispatched.length, 1);
    assert.equal(row.lastScheduledFor, "2026-01-07T22:40:00.000Z");
    assert.equal(row.lastOutcome?.coalescedCount, 9_999);
  }).pipe(Effect.provide(harnessLayer(testState)));
});

it.effect("skips every active previous run without creating an orchestration side effect", () =>
  Effect.gen(function* () {
    const activeStates: ReadonlyArray<Partial<OrchestrationThreadShell>> = [
      { session: { status: "starting" } as OrchestrationThreadShell["session"] },
      { session: { status: "running" } as OrchestrationThreadShell["session"] },
      { hasPendingApprovals: true },
      { hasPendingUserInput: true },
      { latestUserMessageAt: "2026-08-04T10:01:30.000Z" },
      { latestTurn: { state: "running" } as OrchestrationThreadShell["latestTurn"] },
    ];
    for (const active of activeStates) {
      const testState = state();
      testState.shell = {
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        session: null,
        latestTurn: null,
        ...active,
      } as OrchestrationThreadShell;
      yield* Effect.gen(function* () {
        const repository = yield* ScheduledAutomationRepository;
        const scheduler = yield* ScheduledAutomationScheduler;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM local_scheduled_automations_v1`;
        const enabled = yield* enable(repository, "2026-08-04T10:00:00.000Z");
        const previousThreadId = ThreadId.make("previous-thread");
        yield* repository.claimOccurrence({
          automationId,
          expectedRevision: enabled.revision,
          scheduledFor: "2026-08-04T10:01:00.000Z",
          lastThreadId: previousThreadId,
          lastOutcome: {
            kind: "starting",
            scheduledFor: "2026-08-04T10:01:00.000Z",
            observedAt: "2026-08-04T10:01:00.000Z",
            coalescedCount: 0,
          },
          updatedAt: "2026-08-04T10:01:00.000Z",
        });
        const claimed = Option.getOrThrow(yield* repository.get(automationId));
        yield* repository.compareAndSwapUpdate({
          automationId,
          expectedRevision: claimed.revision,
          replacement: {
            ...definition,
            enabled: true,
            enabledAt: claimed.enabledAt,
            lastScheduledFor: claimed.lastScheduledFor,
            lastThreadId: claimed.lastThreadId,
            lastOutcome: { ...claimed.lastOutcome!, kind: "started" },
            updatedAt: claimed.updatedAt,
          },
        });
        yield* TestClock.setTime(Date.parse("2026-08-04T10:02:00.000Z"));
        yield* scheduler.runOnce;
        const skipped = Option.getOrThrow(yield* repository.get(automationId));
        assert.equal(skipped.lastOutcome?.kind, "skipped-active");
        assert.equal(skipped.lastScheduledFor, "2026-08-04T10:02:00.000Z");
        assert.equal(skipped.lastThreadId, previousThreadId);
        assert.equal(testState.dispatched.length, 0);
        const retryError = yield* Effect.flip(scheduler.retry(automationId, skipped.revision));
        assert.equal(retryError._tag, "ScheduledAutomationInvalidStateError");
      }).pipe(Effect.provide(harnessLayer(testState)));
    }
  }),
);

it.effect("allows the next run when the previous turn completed but remains unsettled", () => {
  const testState = state();
  testState.shell = {
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
    latestTurn: { state: "completed" },
    settledOverride: null,
    settledAt: null,
  } as OrchestrationThreadShell;
  return Effect.gen(function* () {
    const repository = yield* ScheduledAutomationRepository;
    const scheduler = yield* ScheduledAutomationScheduler;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM local_scheduled_automations_v1`;
    const enabled = yield* enable(repository, "2026-08-04T10:00:00.000Z");
    const previousThreadId = ThreadId.make("completed-unsettled-thread");
    const starting = yield* repository.claimOccurrence({
      automationId,
      expectedRevision: enabled.revision,
      scheduledFor: "2026-08-04T10:01:00.000Z",
      lastThreadId: previousThreadId,
      lastOutcome: {
        kind: "starting",
        scheduledFor: "2026-08-04T10:01:00.000Z",
        observedAt: "2026-08-04T10:01:00.000Z",
        coalescedCount: 0,
      },
      updatedAt: "2026-08-04T10:01:00.000Z",
    });
    yield* repository.compareAndSwapUpdate({
      automationId,
      expectedRevision: starting.revision,
      replacement: {
        ...definition,
        enabled: true,
        enabledAt: starting.enabledAt,
        lastScheduledFor: starting.lastScheduledFor,
        lastThreadId: starting.lastThreadId,
        lastOutcome: { ...starting.lastOutcome!, kind: "started" },
        updatedAt: starting.updatedAt,
      },
    });
    yield* TestClock.setTime(Date.parse("2026-08-04T10:02:00.000Z"));

    yield* scheduler.runOnce;
    const next = Option.getOrThrow(yield* repository.get(automationId));
    assert.equal(testState.dispatched.length, 1);
    assert.equal(next.lastScheduledFor, "2026-08-04T10:02:00.000Z");
    assert.notEqual(next.lastThreadId, previousThreadId);
    assert.equal(next.lastOutcome?.kind, "started");
  }).pipe(Effect.provide(harnessLayer(testState)));
});

it.effect("persists bounded typed bootstrap failures and retries only on explicit request", () => {
  const testState = state();
  const logRecords: Array<string> = [];
  const logger = Logger.make<unknown, void>((options) => {
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
    const messages = Array.isArray(options.message) ? options.message : [options.message];
    logRecords.push(
      [
        ...messages.map(renderLogValue),
        ...Object.entries(annotations).flatMap(([key, value]) => [key, renderLogValue(value)]),
      ].join(" "),
    );
  });
  testState.bootstrapFailure = {
    code: "provider.temporarily-unavailable",
    message: `temporary Inspect\n\t the workspace. ${"x".repeat(2_000)}`,
    retryable: true,
  };
  return Effect.gen(function* () {
    const repository = yield* ScheduledAutomationRepository;
    const scheduler = yield* ScheduledAutomationScheduler;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM local_scheduled_automations_v1`;
    yield* enable(repository, "2026-08-04T10:00:00.000Z");
    yield* TestClock.setTime(Date.parse("2026-08-04T10:01:00.000Z"));
    yield* scheduler.runOnce;
    const failed = Option.getOrThrow(yield* repository.get(automationId));
    assert.equal(failed.lastOutcome?.kind, "failed");
    if (failed.lastOutcome?.kind !== "failed") return;
    assert.equal(failed.lastOutcome.code, "provider.temporarily-unavailable");
    assert.isTrue(failed.lastOutcome.retryable);
    assert.isAtMost(failed.lastOutcome.detail.length, 1_000);
    assert.notInclude(failed.lastOutcome.detail, definition.prompt);
    const logged = logRecords.join(" ");
    assert.include(logged, automationId);
    assert.include(logged, failed.lastThreadId!);
    assert.notInclude(logged, definition.prompt);

    yield* scheduler.runOnce;
    assert.equal(testState.dispatched.length, 1);
    testState.bootstrapFailure = null;
    const retried = yield* scheduler.retry(automationId, failed.revision);
    assert.equal(retried.lastScheduledFor, failed.lastScheduledFor);
    assert.equal(retried.lastThreadId, failed.lastThreadId);
    assert.equal(retried.lastOutcome?.kind, "started");
    assert.equal(testState.dispatched.length, 2);
  }).pipe(
    Effect.provide(
      Layer.merge(harnessLayer(testState), Logger.layer([logger], { mergeWithExisting: false })),
    ),
  );
});

it.effect("claims then records a typed failure when live configuration went stale", () => {
  const testState = state();
  testState.validationFailure = true;
  return Effect.gen(function* () {
    const repository = yield* ScheduledAutomationRepository;
    const scheduler = yield* ScheduledAutomationScheduler;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM local_scheduled_automations_v1`;
    yield* enable(repository, "2026-08-04T10:00:00.000Z");
    yield* TestClock.setTime(Date.parse("2026-08-04T10:01:00.000Z"));

    yield* scheduler.runOnce;
    const failed = Option.getOrThrow(yield* repository.get(automationId));
    assert.equal(failed.lastScheduledFor, "2026-08-04T10:01:00.000Z");
    assert.equal(failed.lastOutcome?.kind, "failed");
    if (failed.lastOutcome?.kind !== "failed") return;
    assert.equal(failed.lastOutcome.code, "automation.configuration-unavailable");
    assert.isTrue(failed.lastOutcome.retryable);
    assert.equal(testState.dispatched.length, 0);
  }).pipe(Effect.provide(harnessLayer(testState)));
});

it.effect(
  "the scoped coordinator wakes on committed changes and the nearest fake-clock due time",
  () => {
    const testState = state();
    return Effect.gen(function* () {
      testState.started = yield* Deferred.make<void>();
      const repository = yield* ScheduledAutomationRepository;
      const scheduler = yield* ScheduledAutomationScheduler;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM local_scheduled_automations_v1`;
      yield* TestClock.setTime(Date.parse("2026-08-04T10:00:30.000Z"));
      const created = yield* repository.create({
        id: automationId,
        definition,
        createdAt: "2026-08-04T10:00:30.000Z",
      });
      const coordinator = yield* Effect.forkChild(scheduler.run);
      yield* Effect.yieldNow;

      yield* repository.compareAndSwapUpdate({
        automationId,
        expectedRevision: created.revision,
        replacement: {
          ...definition,
          enabled: true,
          enabledAt: "2026-08-04T10:00:30.000Z",
          lastScheduledFor: null,
          lastThreadId: null,
          lastOutcome: null,
          updatedAt: "2026-08-04T10:00:30.000Z",
        },
      });
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(testState.started);

      const row = Option.getOrThrow(yield* repository.get(automationId));
      assert.equal(testState.dispatched.length, 1);
      assert.equal(row.lastScheduledFor, "2026-08-04T10:01:00.000Z");
      yield* Fiber.interrupt(coordinator);
    }).pipe(Effect.provide(harnessLayer(testState)));
  },
);

it.effect("backs off persistent reconciliation failures until fake time advances", () => {
  const testState = state();
  testState.receiptFailure = true;
  return Effect.gen(function* () {
    const repository = yield* ScheduledAutomationRepository;
    const scheduler = yield* ScheduledAutomationScheduler;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM local_scheduled_automations_v1`;
    const enabled = yield* enable(repository, "2026-08-04T10:00:00.000Z");
    const starting = yield* repository.claimOccurrence({
      automationId,
      expectedRevision: enabled.revision,
      scheduledFor: "2026-08-04T10:01:00.000Z",
      lastThreadId: ThreadId.make("persistently-failing-thread"),
      lastOutcome: {
        kind: "starting",
        scheduledFor: "2026-08-04T10:01:00.000Z",
        observedAt: "2026-08-04T10:01:00.000Z",
        coalescedCount: 0,
      },
      updatedAt: "2026-08-04T10:01:00.000Z",
    });
    yield* repository.compareAndSwapUpdate({
      automationId,
      expectedRevision: starting.revision,
      replacement: {
        ...definition,
        enabled: false,
        enabledAt: null,
        lastScheduledFor: starting.lastScheduledFor,
        lastThreadId: starting.lastThreadId,
        lastOutcome: starting.lastOutcome,
        updatedAt: "2026-08-04T10:01:01.000Z",
      },
    });
    yield* TestClock.setTime(Date.parse("2026-08-04T10:01:30.000Z"));

    testState.receiptAttempted = yield* Deferred.make<number>();
    const coordinator = yield* Effect.forkChild(scheduler.run);
    assert.equal(yield* Deferred.await(testState.receiptAttempted), 1);
    testState.receiptAttempted = yield* Deferred.make<number>();

    yield* TestClock.adjust("999 millis");
    yield* Effect.yieldNow;
    assert.equal(testState.receiptAttempts, 1);

    yield* TestClock.adjust("1 millis");
    assert.equal(yield* Deferred.await(testState.receiptAttempted), 2);
    assert.equal(testState.dispatched.length, 0);
    yield* Fiber.interrupt(coordinator);
  }).pipe(Effect.provide(harnessLayer(testState)));
});

it.effect("conflates duplicate committed definition-change signals", () => {
  const testState = state();
  let cycleEntered: Deferred.Deferred<void> | null = null;
  let releaseCycle: Deferred.Deferred<void> | null = null;
  let secondCycleCompleted: Deferred.Deferred<void> | null = null;
  let cycles = 0;
  const schedulerOptions: ScheduledAutomationSchedulerOptions = {
    onCycleStarted: Effect.sync(() => {
      cycles += 1;
      return cycles;
    }).pipe(
      Effect.flatMap((cycle) => {
        if (cycle !== 1 || cycleEntered === null || releaseCycle === null) return Effect.void;
        return Deferred.succeed(cycleEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCycle)),
        );
      }),
    ),
    onCycleCompleted: () =>
      cycles === 2 && secondCycleCompleted !== null
        ? Deferred.succeed(secondCycleCompleted, undefined)
        : Effect.void,
  };
  return Effect.gen(function* () {
    cycleEntered = yield* Deferred.make<void>();
    releaseCycle = yield* Deferred.make<void>();
    secondCycleCompleted = yield* Deferred.make<void>();
    const repository = yield* ScheduledAutomationRepository;
    const scheduler = yield* ScheduledAutomationScheduler;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM local_scheduled_automations_v1`;
    let current = yield* repository.create({
      id: automationId,
      definition,
      createdAt: "2026-08-04T10:00:00.000Z",
    });
    const coordinator = yield* Effect.forkChild(scheduler.run);
    yield* Deferred.await(cycleEntered);

    for (let index = 0; index < 12; index += 1) {
      current = yield* repository.compareAndSwapUpdate({
        automationId,
        expectedRevision: current.revision,
        replacement: {
          ...definition,
          name: `Signal ${index}`,
          enabled: false,
          enabledAt: null,
          lastScheduledFor: null,
          lastThreadId: null,
          lastOutcome: null,
          updatedAt: `2026-08-04T10:00:${String(index).padStart(2, "0")}.000Z`,
        },
      });
    }
    yield* Deferred.succeed(releaseCycle, undefined);
    yield* Deferred.await(secondCycleCompleted);
    yield* Effect.yieldNow;

    assert.equal(cycles, 2);
    assert.equal(current.revision, 13);
    assert.equal(testState.dispatched.length, 0);
    yield* Fiber.interrupt(coordinator);
  }).pipe(Effect.provide(harnessLayer(testState, schedulerOptions)));
});

it.effect("conflates self-generated wake signals for a many-automation batch", () => {
  const testState = state();
  const cycles = { started: 0, completed: 0, evaluations: 0 };
  let secondCycleCompleted: Deferred.Deferred<void> | null = null;
  const schedulerOptions: ScheduledAutomationSchedulerOptions = {
    onCycleStarted: Effect.sync(() => {
      cycles.started += 1;
    }),
    onAutomationEvaluated: () =>
      Effect.sync(() => {
        cycles.evaluations += 1;
      }),
    onCycleCompleted: () =>
      Effect.sync(() => {
        cycles.completed += 1;
      }).pipe(
        Effect.flatMap(() =>
          cycles.completed < 2 || secondCycleCompleted === null
            ? Effect.void
            : Deferred.succeed(secondCycleCompleted, undefined),
        ),
      ),
  };
  return Effect.gen(function* () {
    secondCycleCompleted = yield* Deferred.make<void>();
    const repository = yield* ScheduledAutomationRepository;
    const scheduler = yield* ScheduledAutomationScheduler;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM local_scheduled_automations_v1`;
    const automationCount = 24;
    for (let index = 0; index < automationCount; index += 1) {
      const id = ScheduledAutomationId.make(`scheduler-batch-${index}`);
      const created = yield* repository.create({
        id,
        definition: { ...definition, name: `Batch ${index}` },
        createdAt: "2026-08-04T10:00:00.000Z",
      });
      yield* repository.compareAndSwapUpdate({
        automationId: id,
        expectedRevision: created.revision,
        replacement: {
          ...definition,
          name: `Batch ${index}`,
          enabled: true,
          enabledAt: "2026-08-04T10:00:00.000Z",
          lastScheduledFor: null,
          lastThreadId: null,
          lastOutcome: null,
          updatedAt: "2026-08-04T10:00:00.000Z",
        },
      });
    }
    yield* TestClock.setTime(Date.parse("2026-08-04T10:01:00.000Z"));

    const coordinator = yield* Effect.forkChild(scheduler.run);
    yield* Deferred.await(secondCycleCompleted);
    yield* Effect.yieldNow;

    assert.equal(testState.dispatched.length, automationCount);
    assert.equal(cycles.started, 2);
    assert.equal(cycles.completed, 2);
    assert.equal(cycles.evaluations, automationCount * 2);
    yield* Fiber.interrupt(coordinator);
  }).pipe(Effect.provide(harnessLayer(testState, schedulerOptions)));
});
