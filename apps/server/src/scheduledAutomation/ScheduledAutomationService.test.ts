import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  OrchestrationProjectShell,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  ScheduledAutomationCommand,
  ScheduledAutomationId,
  SCHEDULED_AUTOMATION_ABANDONED_CODE,
  SCHEDULED_AUTOMATION_BOOTSTRAP_PHASE_REJECTED_CODE,
  ServerProvider,
  type ScheduledAutomation,
  ThreadId,
  type ScheduledAutomationDefinitionDraft,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import {
  ScheduledAutomationRepository,
  ScheduledAutomationRepositoryLive,
} from "./ScheduledAutomationRepository.ts";
import {
  ScheduledAutomationService,
  ScheduledAutomationServiceLive,
} from "./ScheduledAutomationService.ts";
import { ScheduledAutomationScheduler } from "./ScheduledAutomationScheduler.ts";
import * as ScheduledAutomationValidation from "./ScheduledAutomationValidation.ts";

const definition: ScheduledAutomationDefinitionDraft = {
  name: "Nightly maintenance",
  prompt: "Inspect the workspace.",
  projectId: Schema.decodeUnknownSync(OrchestrationProjectShell.fields.id)("project-1"),
  modelSelection: {
    instanceId: Schema.decodeUnknownSync(ServerProvider.fields.instanceId)("codex-work"),
    model: "gpt-5.6",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  worktreePolicy: { kind: "new-worktree", baseBranch: "main", startFromOrigin: true },
  setupScriptPolicy: "skip",
  schedule: { cron: "30 2 * * 1-5", timeZone: "UTC", misfirePolicy: "latest-only" },
};

const project = Schema.decodeUnknownSync(OrchestrationProjectShell)({
  id: "project-1",
  title: "Project",
  workspaceRoot: "/workspace/project-1",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
});

const provider = Schema.decodeUnknownSync(ServerProvider)({
  instanceId: "codex-work",
  driver: "codex",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-01T00:00:00.000Z",
  models: [
    {
      slug: "gpt-5.6",
      name: "GPT-5.6",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning effort",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
          { id: "fastMode", label: "Fast mode", type: "boolean" },
        ],
      },
    },
  ],
});

interface HarnessState {
  projectAvailable: boolean;
  providerAvailable: boolean;
  isRepo: boolean;
  baseRefAvailable: boolean;
  baseRefBeyondFirstPage: boolean;
  refPageCalls: number;
  schedulerRetryResult: ScheduledAutomation | null;
  schedulerRetryCalls: Array<{ readonly automationId: string; readonly expectedRevision: number }>;
  schedulerStatus: "starting" | "running" | "failed";
  lastThread: OrchestrationThreadShell | null;
  threadShellReads: number;
  threadShellReadGate: {
    readonly entered: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  } | null;
  domainEvents: Stream.Stream<OrchestrationEvent>;
  subscribeDomainEvents: Effect.Effect<Stream.Stream<OrchestrationEvent>, never, Scope.Scope>;
}

function testLayerWithPersistence<PersistenceError, PersistenceRequirements>(
  state: HarnessState,
  persistence: Layer.Layer<SqlClient.SqlClient, PersistenceError, PersistenceRequirements>,
) {
  const projections: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape = {
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    searchThreads: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getProjectShellById: () =>
      Effect.succeed(state.projectAvailable ? Option.some(project) : Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: () =>
      Effect.gen(function* () {
        state.threadShellReads += 1;
        const gate = state.threadShellReadGate;
        if (gate !== null) {
          state.threadShellReadGate = null;
          yield* Deferred.succeed(gate.entered, undefined);
          yield* Deferred.await(gate.release);
        }
        return Option.fromNullishOr(state.lastThread);
      }),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: () => Effect.die("unused"),
  };
  const providerRegistry: ProviderRegistry.ProviderRegistryShape = {
    getProviders: Effect.sync(() => (state.providerAvailable ? [provider] : [])),
    refresh: () => Effect.die("unused"),
    refreshInstance: () => Effect.die("unused"),
    getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
    setProviderMaintenanceActionState: () => Effect.die("unused"),
    streamChanges: Stream.empty,
  };
  const git = {
    listRefs: (input: { readonly cursor?: number }) =>
      Effect.sync(() => {
        state.refPageCalls += 1;
        const targetPage = !state.baseRefBeyondFirstPage || input.cursor === 100;
        const hasTarget = state.baseRefAvailable && targetPage;
        return {
          refs: hasTarget
            ? [{ name: "main", current: true, isDefault: true, worktreePath: null }]
            : [{ name: "main-backup", current: false, isDefault: false, worktreePath: null }],
          isRepo: state.isRepo,
          hasPrimaryRemote: true,
          nextCursor: state.baseRefBeyondFirstPage && input.cursor === undefined ? 100 : null,
          totalCount: state.baseRefBeyondFirstPage ? 101 : 1,
        };
      }),
  } as unknown as GitWorkflow.GitWorkflowService["Service"];

  return ScheduledAutomationServiceLive.pipe(
    Layer.provideMerge(ScheduledAutomationRepositoryLive),
    Layer.provideMerge(ScheduledAutomationValidation.layer),
    Layer.provide(
      Layer.succeed(ScheduledAutomationScheduler, {
        runOnce: Effect.void,
        run: Effect.never,
        retry: (automationId, expectedRevision) =>
          Effect.sync(() => {
            state.schedulerRetryCalls.push({ automationId, expectedRevision });
            if (state.schedulerRetryResult === null) {
              throw new Error("Unexpected retryable scheduler call.");
            }
            return state.schedulerRetryResult;
          }),
        health: Effect.sync(() => state.schedulerStatus),
        subscribeHealth: Effect.succeed(Stream.empty),
      }),
    ),
    Layer.provideMerge(persistence),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, projections),
        Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          dispatch: () => Effect.die("unused"),
          streamDomainEvents: state.domainEvents,
          subscribeDomainEvents: state.subscribeDomainEvents,
          latestSequence: Effect.succeed(0),
        }),
        Layer.succeed(ProviderRegistry.ProviderRegistry, providerRegistry),
        Layer.succeed(GitWorkflow.GitWorkflowService, git),
      ),
    ),
  );
}

const testLayer = (state: HarnessState) => testLayerWithPersistence(state, SqlitePersistenceMemory);

const decodeCommand = Schema.decodeUnknownEffect(ScheduledAutomationCommand);
const createCommand = (overrides: Record<string, unknown> = {}) =>
  decodeCommand({
    type: "scheduledAutomation.create",
    commandId: "automation-create",
    automationId: "nightly-maintenance",
    definition,
    createdAt: "2000-01-01T00:00:00.000Z",
    ...overrides,
  });

const initialState = (): HarnessState => ({
  projectAvailable: true,
  providerAvailable: true,
  isRepo: true,
  baseRefAvailable: true,
  baseRefBeyondFirstPage: false,
  refPageCalls: 0,
  schedulerRetryResult: null,
  schedulerRetryCalls: [],
  schedulerStatus: "running",
  lastThread: null,
  threadShellReads: 0,
  threadShellReadGate: null,
  domainEvents: Stream.empty,
  subscribeDomainEvents: Effect.succeed(Stream.empty),
});

it.effect("keeps the private SQL namespace behind the repository boundary", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    for (const sourceFile of [
      "ScheduledAutomationService.ts",
      "ScheduledAutomationScheduler.ts",
      "ScheduledAutomationValidation.ts",
    ]) {
      const source = yield* fileSystem.readFileString(
        decodeURIComponent(new URL(`./${sourceFile}`, import.meta.url).pathname),
      );
      assert.notInclude(source, "local_scheduled_automations_v1", sourceFile);
      assert.notInclude(source, "unstable/sql", sourceFile);
      assert.notInclude(source, "SqlClient", sourceFile);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("creates disabled definitions and returns field-addressed schedule errors", () => {
  const state = initialState();
  return Effect.gen(function* () {
    const service = yield* ScheduledAutomationService;
    const created = yield* service.dispatch(yield* createCommand());
    assert.equal(created.automation?.revision, 1);
    assert.equal(created.automation?.enabled, false);
    assert.equal(created.automation?.enabledAt, null);

    const invalid = yield* Effect.flip(
      service.dispatch(
        yield* createCommand({
          automationId: "invalid-schedule",
          definition: {
            ...definition,
            schedule: { ...definition.schedule, cron: "61 * * * *" },
          },
        }),
      ),
    );
    assert.equal(invalid._tag, "ScheduledAutomationValidationError");
    if (invalid._tag === "ScheduledAutomationValidationError") {
      assert.equal(invalid.field, "schedule.cron");
    }
  }).pipe(Effect.provide(testLayer(state)), Effect.scoped);
});

it.effect("reports malformed stored definitions without hiding valid chat operation", () => {
  const state = initialState();
  return Effect.gen(function* () {
    const service = yield* ScheduledAutomationService;
    const sql = yield* SqlClient.SqlClient;
    const secret = "wp5-health-secret-must-not-escape";
    const malformedDefinition = `{"prompt":"${secret}"}`;
    yield* sql`
      INSERT INTO local_scheduled_automations_v1 (
        id, schema_version, revision, definition_json, enabled, enabled_at,
        last_scheduled_for, last_thread_id, last_outcome_json, created_at, updated_at
      ) VALUES (
        'malformed-row', 1, 1, ${malformedDefinition}, 0, NULL,
        NULL, NULL, NULL, '2026-08-05T00:00:00.000Z', '2026-08-05T00:00:00.000Z'
      )
    `;

    assert.deepStrictEqual(yield* service.list(), []);
    const health = yield* service.health();
    assert.deepStrictEqual(health, {
      status: "degraded",
      schedulerStatus: "running",
      malformedDefinitionCount: 1,
    });
    const getError = yield* service
      .get(ScheduledAutomationId.make("malformed-row"))
      .pipe(Effect.flip);
    assert.equal(getError._tag, "ScheduledAutomationInternalError");
    assert.notInclude(getError.message, secret);
  }).pipe(Effect.provide(testLayer(state)), Effect.scoped);
});

it.effect("reports a failed scheduler without failing automation reads", () => {
  const state = initialState();
  state.schedulerStatus = "failed";
  return Effect.gen(function* () {
    const service = yield* ScheduledAutomationService;
    assert.deepStrictEqual(yield* service.list(), []);
    assert.deepStrictEqual(yield* service.health(), {
      status: "degraded",
      schedulerStatus: "failed",
      malformedDefinitionCount: 0,
    });
  }).pipe(Effect.provide(testLayer(state)), Effect.scoped);
});

it.effect("pushes refreshed health when a repository change reveals malformed storage", () => {
  const state = initialState();
  return Effect.gen(function* () {
    const service = yield* ScheduledAutomationService;
    const sql = yield* SqlClient.SqlClient;
    const stream = yield* service.subscribe;
    const collected = yield* Stream.runCollect(stream.pipe(Stream.take(2))).pipe(Effect.forkScoped);
    yield* sql`
      INSERT INTO local_scheduled_automations_v1 (
        id, schema_version, revision, definition_json, enabled, enabled_at,
        last_scheduled_for, last_thread_id, last_outcome_json, created_at, updated_at
      ) VALUES (
        'late-malformed-row', 1, 1, '{"prompt":"late-secret"}', 0, NULL,
        NULL, NULL, NULL, '2026-08-05T00:00:00.000Z', '2026-08-05T00:00:00.000Z'
      )
    `;
    yield* service.dispatch(yield* createCommand());

    const items = Array.from(yield* Fiber.join(collected));
    assert.equal(items[1]?.kind, "snapshot");
    if (items[1]?.kind === "snapshot") {
      assert.equal(items[1].health.status, "degraded");
      assert.equal(items[1].health.malformedDefinitionCount, 1);
    }
  }).pipe(Effect.provide(testLayer(state)), Effect.scoped);
});

it.effect("validates live project, provider, Git repository, and base ref on enable", () => {
  const state = initialState();
  return Effect.gen(function* () {
    const service = yield* ScheduledAutomationService;
    const created = yield* service.dispatch(yield* createCommand());
    const automation = created.automation!;
    const enable = () =>
      Effect.flatMap(
        decodeCommand({
          type: "scheduledAutomation.enabled.set",
          commandId: "enable",
          automationId: automation.id,
          expectedRevision: automation.revision,
          enabled: true,
          createdAt: "2000-01-01T00:00:00.000Z",
        }),
        service.dispatch,
      );

    state.projectAvailable = false;
    assert.equal((yield* Effect.flip(enable()))._tag, "ScheduledAutomationValidationError");
    state.projectAvailable = true;
    state.providerAvailable = false;
    assert.equal((yield* Effect.flip(enable()))._tag, "ScheduledAutomationValidationError");
    state.providerAvailable = true;
    state.isRepo = false;
    assert.equal((yield* Effect.flip(enable()))._tag, "ScheduledAutomationValidationError");
    state.isRepo = true;
    state.baseRefAvailable = false;
    assert.equal((yield* Effect.flip(enable()))._tag, "ScheduledAutomationValidationError");
    state.baseRefAvailable = true;
    state.baseRefBeyondFirstPage = true;
    const callsBeforePagination = state.refPageCalls;
    const enabled = yield* enable();
    assert.equal(enabled.automation?.revision, 2);
    assert.equal(enabled.automation?.enabled, true);
    assert.isNotNull(enabled.automation?.enabledAt);
    assert.equal(state.refPageCalls - callsBeforePagination, 2);
    state.baseRefBeyondFirstPage = false;

    state.projectAvailable = false;
    state.providerAvailable = false;
    const stale = yield* Effect.flip(enable());
    assert.equal(stale._tag, "ScheduledAutomationConflictError");

    state.projectAvailable = true;
    state.providerAvailable = true;
    const unsupported = (yield* service.dispatch(
      yield* createCommand({
        automationId: "unsupported-option",
        definition: {
          ...definition,
          modelSelection: {
            ...definition.modelSelection,
            options: [{ id: "not-supported", value: true }],
          },
        },
      }),
    )).automation!;
    const unsupportedOption = yield* Effect.flip(
      Effect.flatMap(
        decodeCommand({
          type: "scheduledAutomation.enabled.set",
          commandId: "enable-unsupported-option",
          automationId: unsupported.id,
          expectedRevision: unsupported.revision,
          enabled: true,
          createdAt: unsupported.createdAt,
        }),
        service.dispatch,
      ),
    );
    assert.equal(unsupportedOption._tag, "ScheduledAutomationValidationError");
    if (unsupportedOption._tag === "ScheduledAutomationValidationError") {
      assert.equal(unsupportedOption.field, "modelSelection");
    }
  }).pipe(Effect.provide(testLayer(state)), Effect.scoped);
});

it.effect("plans re-enabled automations strictly after the new activation boundary", () => {
  const state = initialState();
  return Effect.gen(function* () {
    const service = yield* ScheduledAutomationService;
    const repository = yield* ScheduledAutomationRepository;
    const created = (yield* service.dispatch(yield* createCommand())).automation!;

    yield* TestClock.setTime(Date.parse("2026-08-01T00:00:00.000Z"));
    const firstEnabled = (yield* service.dispatch(
      yield* decodeCommand({
        type: "scheduledAutomation.enabled.set",
        commandId: "enable-first",
        automationId: created.id,
        expectedRevision: created.revision,
        enabled: true,
        createdAt: created.createdAt,
      }),
    )).automation!;
    const claimed = yield* repository.claimOccurrence({
      automationId: firstEnabled.id,
      expectedRevision: firstEnabled.revision,
      scheduledFor: "2026-08-01T02:30:00.000Z",
      lastThreadId: ThreadId.make("t3sa:v1:reactivation:thread"),
      lastOutcome: {
        kind: "starting",
        scheduledFor: "2026-08-01T02:30:00.000Z",
        observedAt: "2026-08-01T02:30:01.000Z",
        coalescedCount: 0,
      },
      updatedAt: "2026-08-01T02:30:01.000Z",
    });
    const disabled = (yield* service.dispatch(
      yield* decodeCommand({
        type: "scheduledAutomation.enabled.set",
        commandId: "disable",
        automationId: claimed.id,
        expectedRevision: claimed.revision,
        enabled: false,
        createdAt: claimed.updatedAt,
      }),
    )).automation!;

    yield* TestClock.setTime(Date.parse("2026-08-03T10:15:00.000Z"));
    const reenabled = (yield* service.dispatch(
      yield* decodeCommand({
        type: "scheduledAutomation.enabled.set",
        commandId: "enable-again",
        automationId: disabled.id,
        expectedRevision: disabled.revision,
        enabled: true,
        createdAt: disabled.updatedAt,
      }),
    )).automation!;
    const disabledIntervalClaim = yield* Effect.flip(
      repository.claimOccurrence({
        automationId: reenabled.id,
        expectedRevision: reenabled.revision,
        scheduledFor: "2026-08-03T02:30:00.000Z",
        lastThreadId: ThreadId.make("t3sa:v1:disabled-interval:thread"),
        lastOutcome: {
          kind: "starting",
          scheduledFor: "2026-08-03T02:30:00.000Z",
          observedAt: "2026-08-03T10:15:01.000Z",
          coalescedCount: 1,
        },
        updatedAt: "2026-08-03T10:15:01.000Z",
      }),
    );
    const view = yield* service.get(reenabled.id);

    assert.equal(reenabled.enabledAt, "2026-08-03T10:15:00.000Z");
    assert.equal(reenabled.lastScheduledFor, "2026-08-01T02:30:00.000Z");
    assert.equal(disabledIntervalClaim._tag, "ScheduledAutomationInvalidStateError");
    if (disabledIntervalClaim._tag === "ScheduledAutomationInvalidStateError") {
      assert.include(disabledIntervalClaim.message, "activation boundary");
    }
    assert.equal(view.nextScheduledFor, "2026-08-04T02:30:00.000Z");
  }).pipe(Effect.provide(testLayer(state)), Effect.scoped);
});

it.effect(
  "validates enabled edits but permits disabled saves with unavailable dependencies",
  () => {
    const state = initialState();
    return Effect.gen(function* () {
      const service = yield* ScheduledAutomationService;
      const created = (yield* service.dispatch(yield* createCommand())).automation!;
      const enabled = (yield* Effect.flatMap(
        decodeCommand({
          type: "scheduledAutomation.enabled.set",
          commandId: "enable",
          automationId: created.id,
          expectedRevision: 1,
          enabled: true,
          createdAt: created.createdAt,
        }),
        service.dispatch,
      )).automation!;
      const deleteEnabled = yield* Effect.flip(
        Effect.flatMap(
          decodeCommand({
            type: "scheduledAutomation.delete",
            commandId: "delete-enabled",
            automationId: enabled.id,
            expectedRevision: enabled.revision,
            createdAt: enabled.updatedAt,
          }),
          service.dispatch,
        ),
      );
      assert.equal(deleteEnabled._tag, "ScheduledAutomationInvalidStateError");

      state.projectAvailable = false;
      state.providerAvailable = false;
      const createdWhileUnavailable = (yield* service.dispatch(
        yield* createCommand({ automationId: "created-while-unavailable" }),
      )).automation!;
      assert.equal(createdWhileUnavailable.enabled, false);
      assert.equal(createdWhileUnavailable.revision, 1);
      const enabledEdit = yield* Effect.flip(
        Effect.flatMap(
          decodeCommand({
            type: "scheduledAutomation.update",
            commandId: "update-enabled-unavailable",
            automationId: enabled.id,
            expectedRevision: enabled.revision,
            definition: { ...definition, name: "Enabled edit" },
            createdAt: enabled.updatedAt,
          }),
          service.dispatch,
        ),
      );
      assert.equal(enabledEdit._tag, "ScheduledAutomationValidationError");
      const disabled = (yield* Effect.flatMap(
        decodeCommand({
          type: "scheduledAutomation.enabled.set",
          commandId: "disable",
          automationId: enabled.id,
          expectedRevision: enabled.revision,
          enabled: false,
          createdAt: enabled.updatedAt,
        }),
        service.dispatch,
      )).automation!;
      assert.equal(disabled.enabled, false);
      assert.equal(disabled.enabledAt, null);
      assert.equal(disabled.revision, enabled.revision + 1);
      const editedWhileDisabled = (yield* Effect.flatMap(
        decodeCommand({
          type: "scheduledAutomation.update",
          commandId: "update-disabled-unavailable",
          automationId: disabled.id,
          expectedRevision: disabled.revision,
          definition: { ...definition, name: "Disabled edit" },
          createdAt: disabled.updatedAt,
        }),
        service.dispatch,
      )).automation!;
      assert.equal(editedWhileDisabled.name, "Disabled edit");
      assert.equal(editedWhileDisabled.revision, disabled.revision + 1);
      const removed = yield* Effect.flatMap(
        decodeCommand({
          type: "scheduledAutomation.delete",
          commandId: "delete",
          automationId: editedWhileDisabled.id,
          expectedRevision: editedWhileDisabled.revision,
          createdAt: editedWhileDisabled.updatedAt,
        }),
        service.dispatch,
      );
      assert.equal(removed.automation, null);
      const repository = yield* ScheduledAutomationRepository;
      assert.isTrue(Option.isNone(yield* repository.get(editedWhileDisabled.id)));
    }).pipe(Effect.provide(testLayer(state)), Effect.scoped);
  },
);

it.effect("abandons a receipt-rejected occurrence before resource correction", () => {
  const state = initialState();
  return Effect.gen(function* () {
    const service = yield* ScheduledAutomationService;
    const repository = yield* ScheduledAutomationRepository;
    const created = (yield* service.dispatch(yield* createCommand())).automation!;
    const enabled = (yield* Effect.flatMap(
      decodeCommand({
        type: "scheduledAutomation.enabled.set",
        commandId: "enable-for-retry",
        automationId: created.id,
        expectedRevision: created.revision,
        enabled: true,
        createdAt: created.createdAt,
      }),
      service.dispatch,
    )).automation!;
    const stream = yield* service.subscribe;
    const collected = yield* Stream.runCollect(stream.pipe(Stream.take(2))).pipe(Effect.forkScoped);
    const claimed = yield* repository.claimOccurrence({
      automationId: enabled.id,
      expectedRevision: enabled.revision,
      scheduledFor: "2026-08-04T02:30:00.000Z",
      lastThreadId: ThreadId.make("t3sa:v1:retry-fixture:thread"),
      lastOutcome: {
        kind: "starting",
        scheduledFor: "2026-08-04T02:30:00.000Z",
        observedAt: "2026-08-04T02:31:00.000Z",
        coalescedCount: 0,
      },
      updatedAt: "2026-08-04T02:31:00.000Z",
    });
    const failed = yield* repository.compareAndSwapUpdate({
      automationId: claimed.id,
      expectedRevision: claimed.revision,
      replacement: {
        ...claimed,
        lastOutcome: {
          kind: "failed",
          scheduledFor: "2026-08-04T02:30:00.000Z",
          observedAt: "2026-08-04T02:31:30.000Z",
          coalescedCount: 0,
          code: "bootstrap.phase-rejected",
          detail: "A deterministic phase command was rejected.",
          retryable: false,
        },
        updatedAt: "2026-08-04T02:31:30.000Z",
      },
    });
    const events = Array.from(yield* Fiber.join(collected));
    assert.deepStrictEqual(
      events.map((event) => event.kind),
      ["snapshot", "upserted"],
    );
    assert.equal(events[1]?.kind, "upserted");
    if (events[1]?.kind === "upserted") {
      assert.deepStrictEqual(events[1].automation.automation, failed);
    }
    const resourceEditError = yield* Effect.flip(
      Effect.flatMap(
        decodeCommand({
          type: "scheduledAutomation.update",
          commandId: "change-failed-occurrence-resources",
          automationId: failed.id,
          expectedRevision: failed.revision,
          definition: { ...definition, worktreePolicy: { kind: "current" } },
          createdAt: failed.updatedAt,
        }),
        service.dispatch,
      ),
    );
    assert.equal(resourceEditError._tag, "ScheduledAutomationInvalidStateError");
    if (resourceEditError._tag === "ScheduledAutomationInvalidStateError") {
      assert.include(resourceEditError.message, "until the failed occurrence is abandoned");
    }
    const retryError = yield* Effect.flip(
      Effect.flatMap(
        decodeCommand({
          type: "scheduledAutomation.retry-last",
          commandId: "retry-before-scheduler",
          automationId: failed.id,
          expectedRevision: failed.revision,
          createdAt: failed.updatedAt,
        }),
        service.dispatch,
      ),
    );
    assert.equal(retryError._tag, "ScheduledAutomationInvalidStateError");
    if (retryError._tag === "ScheduledAutomationInvalidStateError") {
      assert.include(retryError.message, "durably rejected");
    }
    const enabledAbandonError = yield* Effect.flip(
      Effect.flatMap(
        decodeCommand({
          type: "scheduledAutomation.failed.abandon",
          commandId: "abandon-enabled-occurrence",
          automationId: failed.id,
          expectedRevision: failed.revision,
          createdAt: failed.updatedAt,
        }),
        service.dispatch,
      ),
    );
    assert.equal(enabledAbandonError._tag, "ScheduledAutomationInvalidStateError");
    if (enabledAbandonError._tag === "ScheduledAutomationInvalidStateError") {
      assert.include(enabledAbandonError.message, "Disable");
    }
    const disabled = (yield* Effect.flatMap(
      decodeCommand({
        type: "scheduledAutomation.enabled.set",
        commandId: "disable-rejected-occurrence",
        automationId: failed.id,
        expectedRevision: failed.revision,
        enabled: false,
        createdAt: failed.updatedAt,
      }),
      service.dispatch,
    )).automation!;
    const abandoned = (yield* Effect.flatMap(
      decodeCommand({
        type: "scheduledAutomation.failed.abandon",
        commandId: "abandon-rejected-occurrence",
        automationId: disabled.id,
        expectedRevision: disabled.revision,
        createdAt: disabled.updatedAt,
      }),
      service.dispatch,
    )).automation!;
    const corrected = (yield* Effect.flatMap(
      decodeCommand({
        type: "scheduledAutomation.update",
        commandId: "correct-abandoned-resources",
        automationId: abandoned.id,
        expectedRevision: abandoned.revision,
        definition: {
          ...definition,
          projectId: "replacement-project",
          worktreePolicy: {
            kind: "new-worktree",
            baseBranch: "replacement-main",
            startFromOrigin: false,
          },
        },
        createdAt: abandoned.updatedAt,
      }),
      service.dispatch,
    )).automation!;

    assert.equal(corrected.projectId, "replacement-project");
    assert.equal(corrected.worktreePolicy.kind, "new-worktree");
    assert.equal(corrected.lastThreadId, failed.lastThreadId);
    assert.equal(corrected.lastOutcome?.kind, "failed");
    if (corrected.lastOutcome?.kind === "failed") {
      assert.equal(corrected.lastOutcome.code, "occurrence.abandoned");
      assert.isFalse(corrected.lastOutcome.retryable);
    }
    const abandonedRetry = yield* Effect.flip(
      Effect.flatMap(
        decodeCommand({
          type: "scheduledAutomation.retry-last",
          commandId: "retry-abandoned-occurrence",
          automationId: corrected.id,
          expectedRevision: corrected.revision,
          createdAt: corrected.updatedAt,
        }),
        service.dispatch,
      ),
    );
    assert.equal(abandonedRetry._tag, "ScheduledAutomationInvalidStateError");
    if (abandonedRetry._tag === "ScheduledAutomationInvalidStateError") {
      assert.include(abandonedRetry.message, "abandoned and cannot be retried");
    }
  }).pipe(Effect.provide(testLayer(state)), Effect.scoped);
});

it.effect("hands retryable retry-last commands to durable reconciliation", () => {
  const state = initialState();
  return Effect.gen(function* () {
    const service = yield* ScheduledAutomationService;
    const repository = yield* ScheduledAutomationRepository;
    const created = (yield* service.dispatch(yield* createCommand())).automation!;
    const enabled = (yield* Effect.flatMap(
      decodeCommand({
        type: "scheduledAutomation.enabled.set",
        commandId: "enable-retryable-fixture",
        automationId: created.id,
        expectedRevision: created.revision,
        enabled: true,
        createdAt: created.createdAt,
      }),
      service.dispatch,
    )).automation!;
    const scheduledFor = "2026-08-04T02:30:00.000Z";
    const claimed = yield* repository.claimOccurrence({
      automationId: enabled.id,
      expectedRevision: enabled.revision,
      scheduledFor,
      lastThreadId: ThreadId.make("t3sa:v1:retryable-fixture:thread"),
      lastOutcome: {
        kind: "starting",
        scheduledFor,
        observedAt: scheduledFor,
        coalescedCount: 0,
      },
      updatedAt: scheduledFor,
    });
    const failed = yield* repository.compareAndSwapUpdate({
      automationId: claimed.id,
      expectedRevision: claimed.revision,
      replacement: {
        ...claimed,
        lastOutcome: {
          kind: "failed",
          scheduledFor,
          observedAt: "2026-08-04T02:31:00.000Z",
          coalescedCount: 0,
          code: "provider.temporarily-unavailable",
          detail: "The provider is temporarily unavailable.",
          retryable: true,
        },
        updatedAt: "2026-08-04T02:31:00.000Z",
      },
    });
    state.schedulerRetryResult = {
      ...failed,
      revision: failed.revision + 2,
      lastOutcome: {
        kind: "started",
        scheduledFor,
        observedAt: "2026-08-04T02:32:00.000Z",
        coalescedCount: 0,
      },
      updatedAt: "2026-08-04T02:32:00.000Z",
    };

    const retried = yield* Effect.flatMap(
      decodeCommand({
        type: "scheduledAutomation.retry-last",
        commandId: "retry-retryable-fixture",
        automationId: failed.id,
        expectedRevision: failed.revision,
        createdAt: failed.updatedAt,
      }),
      service.dispatch,
    );
    assert.deepStrictEqual(retried.automation, state.schedulerRetryResult);
    assert.deepStrictEqual(state.schedulerRetryCalls, [
      { automationId: failed.id, expectedRevision: failed.revision },
    ]);
  }).pipe(Effect.provide(testLayer(state)));
});

it.effect("rejects retry for invariant-sensitive legacy failures", () => {
  const state = initialState();
  return Effect.gen(function* () {
    const service = yield* ScheduledAutomationService;
    const sql = yield* SqlClient.SqlClient;
    for (const [index, code] of [
      SCHEDULED_AUTOMATION_BOOTSTRAP_PHASE_REJECTED_CODE,
      SCHEDULED_AUTOMATION_ABANDONED_CODE,
    ].entries()) {
      const created = (yield* service.dispatch(
        yield* createCommand({
          commandId: `create-legacy-failure-${index}`,
          automationId: `legacy-failure-${index}`,
        }),
      )).automation!;
      const legacyOutcomeJson = `{"kind":"failed","scheduledFor":"2026-08-04T02:30:00.000Z","observedAt":"2026-08-04T02:31:00.000Z","coalescedCount":0,"code":"${code}","detail":"Legacy failure without retryability."}`;
      yield* sql`
        UPDATE local_scheduled_automations_v1
        SET last_outcome_json = ${legacyOutcomeJson}
        WHERE id = ${created.id}
      `;

      const decoded = yield* service.get(created.id);
      assert.equal(decoded.automation.lastOutcome?.kind, "failed");
      if (decoded.automation.lastOutcome?.kind === "failed") {
        assert.isFalse(decoded.automation.lastOutcome.retryable);
      }
      const retryError = yield* Effect.flip(
        service.dispatch(
          yield* decodeCommand({
            type: "scheduledAutomation.retry-last",
            commandId: `retry-legacy-failure-${index}`,
            automationId: created.id,
            expectedRevision: created.revision,
            createdAt: created.updatedAt,
          }),
        ),
      );
      assert.equal(retryError._tag, "ScheduledAutomationInvalidStateError");
      if (retryError._tag === "ScheduledAutomationInvalidStateError") {
        assert.match(retryError.message, /rejected|abandoned/);
      }
    }
  }).pipe(Effect.provide(testLayer(state)), Effect.scoped);
});

it.effect("rejects execution-definition edits while an occurrence is starting", () => {
  const state = initialState();
  return Effect.gen(function* () {
    const service = yield* ScheduledAutomationService;
    const repository = yield* ScheduledAutomationRepository;
    const created = (yield* service.dispatch(yield* createCommand())).automation!;
    const enabled = (yield* Effect.flatMap(
      decodeCommand({
        type: "scheduledAutomation.enabled.set",
        commandId: "enable-starting-fixture",
        automationId: created.id,
        expectedRevision: created.revision,
        enabled: true,
        createdAt: created.createdAt,
      }),
      service.dispatch,
    )).automation!;
    const starting = yield* repository.claimOccurrence({
      automationId: enabled.id,
      expectedRevision: enabled.revision,
      scheduledFor: "2026-08-04T02:30:00.000Z",
      lastThreadId: ThreadId.make("t3sa:v1:starting-fixture:thread"),
      lastOutcome: {
        kind: "starting",
        scheduledFor: "2026-08-04T02:30:00.000Z",
        observedAt: "2026-08-04T02:31:00.000Z",
        coalescedCount: 0,
      },
      updatedAt: "2026-08-04T02:31:00.000Z",
    });
    const error = yield* Effect.flip(
      Effect.flatMap(
        decodeCommand({
          type: "scheduledAutomation.update",
          commandId: "update-starting-execution",
          automationId: starting.id,
          expectedRevision: starting.revision,
          definition: {
            ...definition,
            name: "Changed name",
            prompt: "Changed prompt",
            projectId: "different-project",
            modelSelection: { instanceId: "different-provider", model: "different-model" },
            runtimeMode: "approval-required",
            interactionMode: "plan",
            worktreePolicy: { kind: "current" },
            schedule: { cron: "45 3 * * *", timeZone: "UTC", misfirePolicy: "latest-only" },
          },
          createdAt: "2026-08-04T02:32:00.000Z",
        }),
        service.dispatch,
      ),
    );

    assert.equal(error._tag, "ScheduledAutomationInvalidStateError");
    if (error._tag === "ScheduledAutomationInvalidStateError") {
      assert.include(error.message, "cannot change while an occurrence is starting");
    }
    assert.deepStrictEqual(Option.getOrThrow(yield* repository.get(starting.id)), starting);
  }).pipe(Effect.provide(testLayer(state)), Effect.scoped);
});

it.effect("streams an SQLite snapshot followed by committed upsert and remove changes", () => {
  const state = initialState();
  return Effect.gen(function* () {
    const service = yield* ScheduledAutomationService;
    const created = (yield* service.dispatch(yield* createCommand())).automation!;
    const stream = yield* service.subscribe;
    const output =
      yield* Queue.unbounded<import("@t3tools/contracts").ScheduledAutomationStreamItem>();
    yield* stream.pipe(
      Stream.runForEach((item) => Queue.offer(output, item)),
      Effect.forkScoped,
    );
    const snapshot = yield* Queue.take(output);
    const updated = (yield* Effect.flatMap(
      decodeCommand({
        type: "scheduledAutomation.update",
        commandId: "update",
        automationId: created.id,
        expectedRevision: created.revision,
        definition: { ...definition, name: "Updated nightly maintenance" },
        createdAt: created.createdAt,
      }),
      service.dispatch,
    )).automation!;
    const upserted = yield* Queue.take(output);
    yield* Effect.flatMap(
      decodeCommand({
        type: "scheduledAutomation.delete",
        commandId: "delete",
        automationId: "nightly-maintenance",
        expectedRevision: updated.revision,
        createdAt: "2026-08-03T00:00:00.000Z",
      }),
      service.dispatch,
    );
    const removed = yield* Queue.take(output);
    const events = [snapshot, upserted, removed];
    assert.deepStrictEqual(
      events.map((event) => event.kind),
      ["snapshot", "upserted", "removed"],
    );
    assert.equal(events[0]?.kind, "snapshot");
    if (events[0]?.kind === "snapshot") {
      assert.deepStrictEqual(
        events[0].automations.map((view) => view.automation.id),
        [created.id],
      );
    }
    assert.equal(events[1]?.kind, "upserted");
    if (events[1]?.kind === "upserted") {
      assert.equal(events[1].automation.automation.revision, created.revision + 1);
    }
  }).pipe(Effect.provide(testLayer(state)), Effect.scoped);
});

it.effect("refreshes a subscribed view when the linked thread projection changes", () => {
  return Effect.gen(function* () {
    const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
    const state = initialState();
    state.domainEvents = Stream.fromPubSub(liveEvents);
    state.subscribeDomainEvents = PubSub.subscribe(liveEvents).pipe(
      Effect.map(Stream.fromSubscription),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledAutomationService;
      const repository = yield* ScheduledAutomationRepository;
      const created = (yield* service.dispatch(yield* createCommand())).automation!;
      const enabled = (yield* service.dispatch(
        yield* decodeCommand({
          type: "scheduledAutomation.enabled.set",
          commandId: "enable-projection-refresh",
          automationId: created.id,
          expectedRevision: created.revision,
          enabled: true,
          createdAt: created.createdAt,
        }),
      )).automation!;
      const threadId = ThreadId.make("t3sa:v1:projection-refresh:thread");
      yield* repository.claimOccurrence({
        automationId: enabled.id,
        expectedRevision: enabled.revision,
        scheduledFor: "2026-08-05T02:30:00.000Z",
        lastThreadId: threadId,
        lastOutcome: {
          kind: "starting",
          scheduledFor: "2026-08-05T02:30:00.000Z",
          observedAt: "2026-08-05T02:30:01.000Z",
          coalescedCount: 0,
        },
        updatedAt: "2026-08-05T02:30:01.000Z",
      });
      state.lastThread = {
        latestTurn: { state: "running" },
        latestUserMessageAt: "2026-08-05T02:30:00.000Z",
        session: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      } as OrchestrationThreadShell;

      const stream = yield* service.subscribe;
      const collected = yield* Stream.runCollect(stream.pipe(Stream.take(2))).pipe(
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      state.lastThread = {
        ...state.lastThread,
        latestTurn: { state: "completed" },
        latestUserMessageAt: null,
      } as OrchestrationThreadShell;
      yield* PubSub.publish(liveEvents, {
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.session-set",
      } as OrchestrationEvent);

      const items = Array.from(yield* Fiber.join(collected));
      assert.equal(items[0]?.kind, "snapshot");
      assert.equal(items[1]?.kind, "upserted");
      if (items[0]?.kind === "snapshot") assert.equal(items[0].automations[0]?.status, "running");
      if (items[1]?.kind === "upserted") assert.equal(items[1].automation.status, "completed");
    }).pipe(Effect.provide(testLayer(state)), Effect.scoped);
  });
});

it.effect("ignores streamed assistant deltas and refreshes once for a status event", () =>
  Effect.gen(function* () {
    const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
    const state = initialState();
    state.subscribeDomainEvents = PubSub.subscribe(liveEvents).pipe(
      Effect.map(Stream.fromSubscription),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledAutomationService;
      const repository = yield* ScheduledAutomationRepository;
      const created = (yield* service.dispatch(yield* createCommand())).automation!;
      const enabled = (yield* service.dispatch(
        yield* decodeCommand({
          type: "scheduledAutomation.enabled.set",
          commandId: "enable-delta-filter",
          automationId: created.id,
          expectedRevision: created.revision,
          enabled: true,
          createdAt: created.createdAt,
        }),
      )).automation!;
      const threadId = ThreadId.make("t3sa:v1:delta-filter:thread");
      yield* repository.claimOccurrence({
        automationId: enabled.id,
        expectedRevision: enabled.revision,
        scheduledFor: "2026-08-05T02:30:00.000Z",
        lastThreadId: threadId,
        lastOutcome: {
          kind: "starting",
          scheduledFor: "2026-08-05T02:30:00.000Z",
          observedAt: "2026-08-05T02:30:01.000Z",
          coalescedCount: 0,
        },
        updatedAt: "2026-08-05T02:30:01.000Z",
      });
      state.lastThread = {
        latestTurn: { state: "running" },
        latestUserMessageAt: "2026-08-05T02:30:00.000Z",
        session: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      } as OrchestrationThreadShell;

      const stream = yield* service.subscribe;
      const collected = yield* Stream.runCollect(stream.pipe(Stream.take(2))).pipe(
        Effect.forkScoped,
      );
      for (let index = 0; index < 100; index += 1) {
        yield* PubSub.publish(liveEvents, {
          aggregateKind: "thread",
          aggregateId: threadId,
          type: "thread.message-sent",
          payload: { role: "assistant", streaming: true },
        } as OrchestrationEvent);
        yield* PubSub.publish(liveEvents, {
          aggregateKind: "thread",
          aggregateId: threadId,
          type: "thread.activity-appended",
          payload: { activity: { kind: "provider.tool-output.delta" } },
        } as OrchestrationEvent);
      }
      state.lastThread = {
        ...state.lastThread,
        latestTurn: { state: "completed" },
        latestUserMessageAt: null,
      } as OrchestrationThreadShell;
      yield* PubSub.publish(liveEvents, {
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.session-set",
      } as OrchestrationEvent);

      const items = Array.from(yield* Fiber.join(collected));
      assert.equal(items[1]?.kind, "upserted");
      assert.equal(state.threadShellReads, 2);
    }).pipe(Effect.provide(testLayer(state)), Effect.scoped);
  }),
);

it.effect("ends absent when a delayed projection refresh races with deletion", () =>
  Effect.gen(function* () {
    const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
    const state = initialState();
    state.subscribeDomainEvents = PubSub.subscribe(liveEvents).pipe(
      Effect.map(Stream.fromSubscription),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledAutomationService;
      const repository = yield* ScheduledAutomationRepository;
      const created = (yield* service.dispatch(yield* createCommand())).automation!;
      const enabled = (yield* service.dispatch(
        yield* decodeCommand({
          type: "scheduledAutomation.enabled.set",
          commandId: "enable-delete-race",
          automationId: created.id,
          expectedRevision: created.revision,
          enabled: true,
          createdAt: created.createdAt,
        }),
      )).automation!;
      const threadId = ThreadId.make("t3sa:v1:delete-race:thread");
      const claimed = yield* repository.claimOccurrence({
        automationId: enabled.id,
        expectedRevision: enabled.revision,
        scheduledFor: "2026-08-05T02:30:00.000Z",
        lastThreadId: threadId,
        lastOutcome: {
          kind: "starting",
          scheduledFor: "2026-08-05T02:30:00.000Z",
          observedAt: "2026-08-05T02:30:01.000Z",
          coalescedCount: 0,
        },
        updatedAt: "2026-08-05T02:30:01.000Z",
      });
      state.lastThread = {
        latestTurn: { state: "running" },
        latestUserMessageAt: "2026-08-05T02:30:00.000Z",
        session: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      } as OrchestrationThreadShell;

      const stream = yield* service.subscribe;
      const collected = yield* Stream.runCollect(stream.pipe(Stream.take(2))).pipe(
        Effect.forkScoped,
      );
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      state.threadShellReadGate = { entered, release };
      state.lastThread = {
        ...state.lastThread,
        latestTurn: { state: "completed" },
        latestUserMessageAt: null,
      } as OrchestrationThreadShell;
      yield* PubSub.publish(liveEvents, {
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.session-set",
      } as OrchestrationEvent);
      yield* Deferred.await(entered);
      yield* repository.compareAndSwapDelete({
        automationId: claimed.id,
        expectedRevision: claimed.revision,
      });
      yield* Deferred.succeed(release, undefined);

      const items = Array.from(yield* Fiber.join(collected));
      assert.deepStrictEqual(
        items.map((item) => item.kind),
        ["snapshot", "removed"],
      );
    }).pipe(Effect.provide(testLayer(state)), Effect.scoped);
  }),
);

it.effect("reconstructs a subscription snapshot after the service and database restart", () => {
  const state = initialState();
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-scheduled-automation-service-",
    });
    const persistence = Layer.provideMerge(
      Layer.effectDiscard(runMigrations()),
      NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") }),
    );

    const expected = yield* Effect.gen(function* () {
      const service = yield* ScheduledAutomationService;
      return (yield* service.dispatch(yield* createCommand())).automation!;
    }).pipe(Effect.provide(testLayerWithPersistence(state, persistence)), Effect.scoped);

    const first = yield* Effect.gen(function* () {
      const service = yield* ScheduledAutomationService;
      const stream = yield* service.subscribe;
      return yield* Stream.runHead(stream);
    }).pipe(Effect.provide(testLayerWithPersistence(state, persistence)), Effect.scoped);

    assert.isTrue(Option.isSome(first));
    if (Option.isSome(first) && first.value.kind === "snapshot") {
      assert.deepStrictEqual(
        first.value.automations.map((view) => view.automation),
        [expected],
      );
    } else {
      assert.fail("Expected a snapshot as the first subscription item.");
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
});
