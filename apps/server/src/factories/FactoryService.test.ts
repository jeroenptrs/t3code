import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type FactoryRoleFile,
  type FactorySaveInput,
  makeFactoryId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ScheduledTask,
  ScheduledTaskId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as FactoryService from "./FactoryService.ts";
import { builtinRoles } from "./roles/index.ts";

const codex = ProviderInstanceId.make("codex");
const provider: ServerProvider = {
  driver: ProviderDriverKind.make("codex"),
  instanceId: codex,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  checkedAt: "2026-11-01T00:00:00Z",
  auth: { status: "authenticated" },
  models: [{ slug: "gpt-6", name: "GPT-6", isCustom: false, capabilities: null }],
  skills: [],
  slashCommands: [],
};

const project = (id: string, title: string, workspaceRoot: string): ProjectStore.ProjectRow => ({
  projectId: ProjectId.make(id),
  title,
  workspaceRoot,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  deletedAt: null,
});

const task = (id: string): ScheduledTask => ({
  id: ScheduledTaskId.make(id),
  title: "Nightly triage",
  prompt: "Triage new issues.",
  enabled: true,
  schedule: { type: "webhook", signature: null },
  projectId: ProjectId.make("project-backend"),
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: codex, model: "gpt-6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
});

const NOW = DateTime.makeUnsafe("2026-11-01T00:00:00.000Z");
const shell = (
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell>,
): OrchestrationV2ThreadShell => ({
  id: ThreadId.make(id),
  projectId: ProjectId.make("project-backend"),
  title: id,
  providerInstanceId: codex,
  modelSelection: { instanceId: codex, model: "gpt-6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  activeRunId: null,
  latestRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  ...overrides,
});

interface Fixture {
  readonly projects: ReadonlyArray<ProjectStore.ProjectRow>;
  readonly tasks?: ReadonlyArray<ScheduledTask>;
  readonly shells?: ReadonlyArray<OrchestrationV2ThreadShell>;
}

const layerFor = (fixture: Fixture) =>
  FactoryService.layer.pipe(
    Layer.provideMerge(Layer.orDie(SqlitePersistence.layerMemory)),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectStore.ProjectStoreV2)({ list: () => Effect.succeed(fixture.projects) }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: fixture.tasks ?? [] }),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getShellSnapshot: (options) =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: (fixture.shells ?? []).filter((candidate) =>
                options?.threadIds?.includes(candidate.id),
              ),
              archivedThreads: [],
            }),
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/** A temporary checkout with these files, relative to its root. */
const checkout = Effect.fn(function* (files: Record<string, string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-factories-" });
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(root, relative);
    yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
    yield* fileSystem.writeFileString(target, text);
  }
  return root;
});

const factoryJson = (value: object) => JSON.stringify(value);

describe("FactoryService", () => {
  it.effect("lays a role file's bindings and body over the built-in role", () =>
    Effect.gen(function* () {
      const root = yield* checkout({
        ".t3/factories/triage/factory.json": factoryJson({
          name: "triage",
          projects: ["backend", "mobile"],
          roles: { implement: "roles/implement.md", review: "roles/review.md" },
        }),
        ".t3/factories/triage/roles/implement.md":
          "---\nisolation: shared\nskills: [run-checks]\n---\n\nFix the bug.\n",
        ".t3/factories/triage/roles/review.md": "---\nruntimeMode: approval-required\n---\n",
        // Not listed in factory.json: the file at the default path still counts.
        ".t3/factories/triage/roles/foreman.md": "Route everything to implement.\n",
      });
      const backend = project("project-backend", "backend", root);
      const factory = yield* FactoryService.FactoryService.use((factories) =>
        factories.read(makeFactoryId(backend.projectId, "triage")),
      ).pipe(Effect.provide(layerFor({ projects: [backend] })));

      const [foreman, implement, review] = factory.roles;
      assert.deepStrictEqual(foreman, {
        role: "foreman",
        path: "roles/foreman.md",
        source: "file",
        fileBinding: {},
        binding: builtinRoles.foreman.binding,
        body: "Route everything to implement.",
        bodySource: "file",
      });
      assert.deepStrictEqual(implement, {
        role: "implement",
        path: "roles/implement.md",
        source: "file",
        fileBinding: { isolation: "shared", skills: ["run-checks"] },
        binding: { ...builtinRoles.implement.binding, isolation: "shared", skills: ["run-checks"] },
        body: "Fix the bug.",
        bodySource: "file",
      });
      assert.strictEqual(review?.binding.runtimeMode, "approval-required");
      assert.strictEqual(review?.body, builtinRoles.review.body);
      assert.strictEqual(review?.bodySource, "builtin");
      assert.deepStrictEqual(factory.projects, [
        { name: "backend", projectId: backend.projectId },
        { name: "mobile", projectId: null },
      ]);
      assert.deepStrictEqual(
        factory.issues.map((issue) => issue.code),
        ["unknown_project"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lists factories across projects and skips folders that are not one", () =>
    Effect.gen(function* () {
      const backendRoot = yield* checkout({
        ".t3/factories/triage/factory.json": factoryJson({ name: "triage" }),
        ".t3/factories/notes/README.md": "Not a factory.",
        ".t3/factories/Bad Name/factory.json": factoryJson({ name: "Bad Name" }),
      });
      const siteRoot = yield* checkout({
        ".t3/factories/nightly/factory.json": "{ broken",
      });
      const backend = project("project-backend", "backend", backendRoot);
      const site = project("project-site", "site", siteRoot);
      const empty = project("project-empty", "empty", `${siteRoot}/missing`);
      const run = <A, E>(effect: Effect.Effect<A, E, FactoryService.FactoryService>) =>
        effect.pipe(Effect.provide(layerFor({ projects: [backend, site, empty] })));
      const list = (projectId?: ProjectId) =>
        run(FactoryService.FactoryService.use((factories) => factories.list(projectId)));

      const all = yield* list();
      assert.deepStrictEqual(
        all.factories.map((factory) => [factory.id, factory.issueCount]),
        [
          [makeFactoryId(backend.projectId, "triage"), 0],
          [makeFactoryId(site.projectId, "nightly"), 1],
        ],
      );
      const one = yield* list(site.projectId);
      assert.deepStrictEqual(
        one.factories.map((factory) => factory.name),
        ["nightly"],
      );
      const unknown = yield* list(ProjectId.make("project-gone")).pipe(Effect.flip);
      assert.strictEqual(unknown.code, "project_not_found");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("writes a new factory, reads it back, and removes a role file on request", () =>
    Effect.gen(function* () {
      const root = yield* checkout({});
      const backend = project("project-backend", "backend", root);
      const fileSystem = yield* FileSystem.FileSystem;
      const save = (input: FactorySaveInput) =>
        FactoryService.FactoryService.use((factories) => factories.save(input)).pipe(
          Effect.provide(layerFor({ projects: [backend] })),
        );
      const implement: FactoryRoleFile = {
        binding: { model: { instanceId: codex, model: "gpt-6" }, tools: ["Read", "Edit"] },
        body: "Fix the bug the task names.",
      };
      const definition = { name: "triage", projects: ["backend"], triggers: [], roles: {} };

      const saved = yield* save({
        projectId: backend.projectId,
        definition,
        roles: [{ role: "implement", file: implement }],
      });
      assert.deepStrictEqual(saved.definition.roles, { implement: "roles/implement.md" });
      assert.deepStrictEqual(saved.roles[1]?.fileBinding, implement.binding);
      assert.strictEqual(saved.roles[1]?.body, implement.body);
      assert.deepStrictEqual(saved.issues, []);
      const roleFile = `${root}/.t3/factories/triage/roles/implement.md`;
      assert.isTrue(yield* fileSystem.exists(roleFile));

      const reset = yield* save({
        projectId: backend.projectId,
        definition: saved.definition,
        roles: [{ role: "implement", file: null }],
      });
      assert.deepStrictEqual(reset.definition.roles, {});
      assert.strictEqual(reset.roles[1]?.source, "builtin");
      assert.isFalse(yield* fileSystem.exists(roleFile));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a binding the provider catalog does not offer and writes nothing", () =>
    Effect.gen(function* () {
      const root = yield* checkout({});
      const backend = project("project-backend", "backend", root);
      const fileSystem = yield* FileSystem.FileSystem;
      const error = yield* FactoryService.FactoryService.use((factories) =>
        factories.save({
          projectId: backend.projectId,
          definition: { name: "triage", projects: [], triggers: [], roles: {} },
          roles: [
            {
              role: "review",
              file: { binding: { model: { instanceId: codex, model: "gpt-1" } }, body: null },
            },
          ],
        }),
      ).pipe(Effect.provide(layerFor({ projects: [backend] })), Effect.flip);
      assert.strictEqual(error.code, "invalid");
      assert.deepStrictEqual(
        error.issues?.map((issue) => [issue.code, issue.role]),
        [["unknown_model", "review"]],
      );
      assert.isFalse(yield* fileSystem.exists(`${root}/.t3/factories/triage`));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "owns its role threads and its scheduled tasks' threads and counts what needs a person",
    () =>
      Effect.gen(function* () {
        const nightly = task("scheduled-task:nightly");
        const root = yield* checkout({
          ".t3/factories/triage/factory.json": factoryJson({
            name: "triage",
            triggers: [
              { kind: "scheduled_task", scheduledTaskId: nightly.id },
              { kind: "scheduled_task", scheduledTaskId: "scheduled-task:deleted" },
            ],
          }),
        });
        const backend = project("project-backend", "backend", root);
        const factoryId = makeFactoryId(backend.projectId, "triage");

        const result = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const factories = yield* FactoryService.FactoryService;
          const thread = (id: string, deletedAt: string | null = null) => sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, deleted_at, payload_json
          ) VALUES (
            ${id}, ${backend.projectId}, ${id}, 'codex', 'full-access', 'default',
            '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', ${deletedAt}, '{}'
          )
        `;
          const message = (id: string, threadId: string, scheduledTaskId: string | null) => sql`
          INSERT INTO orchestration_v2_projection_messages (
            message_id, thread_id, role, streaming, created_at, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, 'user', 0, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z',
            ${scheduledTaskId === null ? "{}" : `{"scheduledTaskId":"${scheduledTaskId}"}`}
          )
        `;
          yield* thread("t-foreman");
          yield* thread("t-run");
          yield* thread("t-run-deleted", "2026-11-02T00:00:00.000Z");
          yield* thread("t-mine");
          yield* message("m-1", "t-run", nightly.id);
          yield* message("m-2", "t-run", nightly.id);
          yield* message("m-3", "t-run-deleted", nightly.id);
          yield* message("m-4", "t-mine", null);
          yield* message("m-5", "t-mine", "scheduled-task:someone-elses");
          yield* sql`
          INSERT INTO fork_factory_threads (factory_id, thread_id, role, created_at)
          VALUES (${factoryId}, 't-foreman', 'foreman', '2026-11-01T00:00:00.000Z')
        `;
          return {
            factory: yield* factories.read(factoryId),
            list: yield* factories.list(),
          };
        }).pipe(
          Effect.provide(
            layerFor({
              projects: [backend],
              tasks: [nightly],
              shells: [
                shell("t-foreman", { status: "failed" }),
                shell("t-run", {
                  status: "waiting",
                  pendingRuntimeRequest: {
                    id: RuntimeRequestId.make("request-1"),
                    kind: "user_input",
                    createdAt: NOW,
                  },
                }),
                shell("t-mine", { status: "failed" }),
              ],
            }),
          ),
        );

        assert.deepStrictEqual(result.factory.scheduledTaskIds, [nightly.id]);
        assert.deepStrictEqual(result.factory.threads, [
          { threadId: ThreadId.make("t-foreman"), role: "foreman" },
          { threadId: ThreadId.make("t-run"), role: null },
        ]);
        assert.deepStrictEqual(result.factory.attention, {
          gatesWaiting: 0,
          failedRuns: 1,
          questions: 1,
          total: 2,
        });
        assert.deepStrictEqual(
          result.factory.issues.map((issue) => issue.code),
          ["unknown_scheduled_task"],
        );
        assert.deepStrictEqual(result.list.factories[0]?.threadIds, [
          ThreadId.make("t-foreman"),
          ThreadId.make("t-run"),
        ]);
        assert.deepStrictEqual(result.list.factories[0]?.attention, result.factory.attention);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
