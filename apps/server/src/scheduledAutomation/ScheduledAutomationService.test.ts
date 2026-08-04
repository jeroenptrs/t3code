import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  OrchestrationProjectShell,
  ScheduledAutomationCommand,
  ServerProvider,
  ThreadId,
  type ScheduledAutomationDefinitionDraft,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
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
    getThreadShellById: () => Effect.succeed(Option.none()),
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
    Layer.provideMerge(persistence),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, projections),
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
});

it.effect("keeps the private SQL namespace behind the repository boundary", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serviceSource = yield* fileSystem.readFileString(
      decodeURIComponent(new URL("./ScheduledAutomationService.ts", import.meta.url).pathname),
    );
    assert.notInclude(serviceSource, "local_scheduled_automations_v1");
    assert.notInclude(serviceSource, "unstable/sql");
    assert.notInclude(serviceSource, "SqlClient");
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

it.effect("rejects retry until reconciliation exists without mutating the failed row", () => {
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
          code: "fixture.failure",
          detail: "Fixture failure.",
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
      assert.deepStrictEqual(events[1].automation.automation, claimed);
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
      assert.include(retryError.message, "unavailable until scheduled reconciliation");
    }
    assert.deepStrictEqual(Option.getOrThrow(yield* repository.get(failed.id)), failed);
  }).pipe(Effect.provide(testLayer(state)), Effect.scoped);
});

it.effect("streams an SQLite snapshot followed by committed upsert and remove changes", () => {
  const state = initialState();
  return Effect.gen(function* () {
    const service = yield* ScheduledAutomationService;
    const created = (yield* service.dispatch(yield* createCommand())).automation!;
    const stream = yield* service.subscribe;
    const collected = yield* Stream.runCollect(stream.pipe(Stream.take(3))).pipe(Effect.forkScoped);
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
    const events = Array.from(yield* Fiber.join(collected));
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
