import { assert, it } from "@effect/vitest";
import {
  AuthUserId,
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Creating a thread opens no provider session"),
} as ProviderAdapterV2Shape;
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-creator" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const ada = AuthUserId.make("user-ada");

const createThread = (threadId: ThreadId, createdByUserId?: AuthUserId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-creator"),
      title: "Started",
      modelSelection: { instanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      ...(createdByUserId === undefined ? {} : { createdByUserId }),
    });
  });

const shellFromSnapshot = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const snapshot = yield* projections.getShellSnapshot();
    const shell = snapshot.threads.find((thread) => thread.id === threadId);
    assert.ok(shell);
    return shell;
  });

it.effect("records the portal user who started a thread and names them on shell reads", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* sql`
      INSERT INTO auth_users (
        user_id, tenant_id, object_id, status, role, email, display_name, created_at, updated_at
      ) VALUES (
        ${ada}, 't', 'ada', 'active', 'operator', 'ada@example.com', 'Ada Lovelace',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `;
    const threadId = ThreadId.make("thread:started-by-ada");

    const { storedEvents } = yield* createThread(threadId, ada);
    const created = storedEvents.find(({ event }) => event.type === "thread.created")?.event;
    assert.equal(created?.type === "thread.created" ? created.payload.createdByUserId : null, ada);

    // Later thread events rewrite the stored payload and must keep the creator.
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("rename:started-by-ada"),
      threadId,
      title: "Renamed",
    });
    assert.equal((yield* projections.getThread(threadId)).createdByUserId, ada);

    const expected = { userId: ada, name: "Ada Lovelace" };
    assert.deepStrictEqual((yield* projections.getThreadShell(threadId))?.createdByUser, expected);
    assert.deepStrictEqual((yield* shellFromSnapshot(threadId)).createdByUser, expected);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("omits the creator without a user and leaves a removed user unnamed", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const anonymous = ThreadId.make("thread:started-without-user");
    yield* createThread(anonymous);
    assert.notProperty(yield* projections.getThread(anonymous), "createdByUserId");
    assert.notProperty(yield* shellFromSnapshot(anonymous), "createdByUser");

    const removed = AuthUserId.make("user-removed");
    const orphaned = ThreadId.make("thread:started-by-removed-user");
    yield* createThread(orphaned, removed);
    assert.deepStrictEqual((yield* shellFromSnapshot(orphaned)).createdByUser, {
      userId: removed,
      name: null,
    });
  }).pipe(Effect.provide(layerTest)),
);
