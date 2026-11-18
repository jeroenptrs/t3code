import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthUserId,
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
  WorkItemId,
  type WorkItemTriggerSource,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { parseSkillFile } from "./factoryFiles.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactorySkillStore from "./FactorySkillStore.ts";
import { builtinRoles } from "./roles/index.ts";
import { builtinSkills } from "./skills/index.ts";

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
  hasCustomTitle: false,
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
  /** T3 home, for its skills; an empty one when left out. */
  readonly home?: string;
}

const layerSkillStore = (home?: string) =>
  FactorySkillStore.layer.pipe(
    Layer.provide(
      Layer.orDie(ServerConfig.layerTest(process.cwd(), home ?? { prefix: "t3-factories-home-" })),
    ),
  );

const builtinSkill = (name: string) => ({
  name,
  source: "builtin" as const,
  description: parseSkillFile(builtinSkills[name]!).description,
  replaces: null,
});

const layerFor = (fixture: Fixture) =>
  FactoryService.layer.pipe(
    Layer.provideMerge(Layer.orDie(SqlitePersistence.layerMemory)),
    Layer.provide(layerSkillStore(fixture.home)),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectStore.ProjectStoreV2)({ list: () => Effect.succeed(fixture.projects) }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: fixture.tasks ?? [] }),
        }),
        // Definitions and ownership never launch or message a thread.
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(ServerSettings.ServerSettingsService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getShellSnapshot: (options) =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: (fixture.shells ?? []).filter(
                (candidate) =>
                  options?.threadIds?.includes(candidate.id) &&
                  (options.location !== "active" ||
                    (candidate.archivedAt === null && candidate.deletedAt === null)),
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
  it.effect("lays a role file's bindings, body, and skills over the built-in role", () =>
    Effect.gen(function* () {
      const root = yield* checkout({
        ".t3/factories/triage/factory.json": factoryJson({
          name: "triage",
          projects: ["backend", "mobile"],
          roles: { implement: "roles/implement.md", review: "roles/review.md" },
        }),
        ".t3/factories/triage/roles/implement.md":
          "---\nisolation: shared\nskills: [run-checks, implement, lint]\n---\n\nFix the bug.\n",
        ".t3/factories/triage/roles/review.md": "---\nruntimeMode: approval-required\n---\n",
        // Not listed in factory.json: the file at the default path still counts.
        ".t3/factories/triage/roles/foreman.md": "Route everything to implement.\n",
        // A factory skill of a built-in's name replaces it; a folder without SKILL.md is no skill.
        ".t3/factories/triage/skills/run-checks/SKILL.md": "---\nname: run-checks\n---\n",
        ".t3/factories/triage/skills/review/SKILL.md": "---\nname: review\n---\n",
        ".t3/factories/triage/skills/drafts/notes.md": "Not a skill yet.\n",
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
        skills: [],
      });
      const skills = ["run-checks", "implement", "lint"];
      assert.deepStrictEqual(implement, {
        role: "implement",
        path: "roles/implement.md",
        source: "file",
        fileBinding: { isolation: "shared", skills },
        binding: { ...builtinRoles.implement.binding, isolation: "shared", skills },
        body: "Fix the bug.",
        bodySource: "file",
        skills: [
          { name: "run-checks", source: "factory", description: "", replaces: null },
          builtinSkill("implement"),
        ],
      });
      assert.strictEqual(review?.binding.runtimeMode, "approval-required");
      assert.strictEqual(review?.body, builtinRoles.review.body);
      assert.strictEqual(review?.bodySource, "builtin");
      const factoryReview = {
        name: "review",
        source: "factory" as const,
        description: "",
        replaces: "builtin" as const,
      };
      assert.deepStrictEqual(review?.skills, [factoryReview]);
      assert.deepStrictEqual(factory.skills, [
        builtinSkill("implement"),
        factoryReview,
        { name: "run-checks", source: "factory", description: "", replaces: null },
      ]);
      assert.deepStrictEqual(factory.projects, [
        { name: "backend", projectId: backend.projectId },
        { name: "mobile", projectId: null },
      ]);
      assert.deepStrictEqual(
        factory.issues.map((issue) => [issue.code, issue.role, issue.field]),
        [
          ["unknown_skill", "implement", "skills"],
          ["unknown_project", null, "projects"],
        ],
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

  it.effect("writes a new factory, reads it back, and removes role files on request", () =>
    Effect.gen(function* () {
      const skillText = "---\nname: run-checks\ndescription: Runs the checks.\n---\n\nRun them.\n";
      const root = yield* checkout({
        ".t3/factories/triage/skills/run-checks/SKILL.md": skillText,
      });
      const backend = project("project-backend", "backend", root);
      const fileSystem = yield* FileSystem.FileSystem;
      const save = (input: FactorySaveInput) =>
        FactoryService.FactoryService.use((factories) => factories.save(input)).pipe(
          Effect.provide(layerFor({ projects: [backend] })),
        );
      const implement: FactoryRoleFile = {
        binding: {
          model: { instanceId: codex, model: "gpt-6" },
          skills: ["run-checks"],
          tools: ["Read", "Edit"],
        },
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
      assert.deepStrictEqual(saved.roles[1]?.skills, [
        {
          name: "run-checks",
          source: "factory",
          description: "Runs the checks.",
          replaces: null,
        },
      ]);
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
      assert.deepStrictEqual(reset.roles[1]?.skills, [builtinSkill("implement")]);
      assert.isFalse(yield* fileSystem.exists(roleFile));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a model or skill the factory does not offer and writes nothing", () =>
    Effect.gen(function* () {
      const root = yield* checkout({});
      // Only T3 home has run-checks, which is enough.
      const home = yield* checkout({
        "skills/run-checks/SKILL.md": "---\nname: run-checks\n---\n",
      });
      const backend = project("project-backend", "backend", root);
      const fileSystem = yield* FileSystem.FileSystem;
      const error = yield* FactoryService.FactoryService.use((factories) =>
        factories.save({
          projectId: backend.projectId,
          definition: { name: "triage", projects: [], triggers: [], roles: {} },
          roles: [
            {
              role: "review",
              file: {
                binding: {
                  model: { instanceId: codex, model: "gpt-1" },
                  skills: ["lint", "run-checks"],
                },
                body: null,
              },
            },
          ],
        }),
      ).pipe(Effect.provide(layerFor({ projects: [backend], home })), Effect.flip);
      assert.strictEqual(error.code, "invalid");
      assert.deepStrictEqual(
        error.issues?.map((issue) => [issue.code, issue.role, issue.message.includes("lint")]),
        [
          ["unknown_model", "review", false],
          ["unknown_skill", "review", true],
        ],
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
          // A gate holds one item, the Foreman failed one, and a person failed the third.
          yield* thread("t-child");
          const item = (
            id: string,
            stage: string,
            foreman = "t-foreman",
            dismissedAt: string | null = null,
          ) => sql`
          INSERT INTO fork_factory_work_items (
            work_item_id, factory_id, title, source_json, stage, gate_json,
            foreman_thread_id, foreman_run_id, created_at, updated_at, failure_dismissed_at
          ) VALUES (
            ${id}, ${factoryId}, ${id}, '{"kind":"manual","text":"Fix it."}', ${stage},
            '{"state":"none"}', ${foreman}, NULL,
            '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', ${dismissedAt}
          )
        `;
          const transition = (id: string, itemId: string, to: string, actor: string) => sql`
          INSERT INTO fork_factory_work_item_transitions (
            transition_id, work_item_id, from_stage, to_stage, actor_json, note, at
          ) VALUES (${id}, ${itemId}, 'implement', ${to}, ${actor}, NULL, '2026-11-01T00:00:00.000Z')
        `;
          yield* item("work-item:gated", "waiting");
          yield* item("work-item:broke", "failed");
          yield* item("work-item:rejected", "failed");
          yield* transition("x-1", "work-item:broke", "failed", '{"kind":"user","userId":null}');
          yield* transition(
            "x-2",
            "work-item:broke",
            "failed",
            '{"kind":"foreman","threadId":"t-foreman"}',
          );
          yield* transition("x-3", "work-item:rejected", "failed", '{"kind":"user","userId":null}');
          // Failed by the server, but its run thread is settled, archived, or deleted, or a
          // person dismissed the failure: none of them asks for attention any more.
          yield* thread("t-run-settled");
          yield* thread("t-run-archived");
          yield* item("work-item:settled-run", "failed", "t-run-settled");
          yield* item("work-item:archived-run", "failed", "t-run-archived");
          yield* item("work-item:deleted-run", "failed", "t-run-deleted");
          yield* item("work-item:dismissed", "failed", "t-foreman", "2026-11-02T00:00:00.000Z");
          // A person restored a dismissed failure, which is a note, not a person failing it.
          yield* item("work-item:restored", "failed");
          yield* transition("x-4", "work-item:restored", "failed", '{"kind":"server"}');
          yield* sql`
          INSERT INTO fork_factory_work_item_transitions (
            transition_id, work_item_id, from_stage, to_stage, actor_json, note, at
          ) VALUES (
            'x-5', 'work-item:restored', 'failed', 'failed', '{"kind":"user","userId":null}',
            'Restored the failure.', '2026-11-03T00:00:00.000Z'
          )
        `;
          yield* sql`
          INSERT INTO fork_factory_work_item_threads (work_item_id, thread_id, role, created_at)
          VALUES ('work-item:gated', 't-child', 'implement', '2026-11-01T00:00:00.000Z')
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
                shell("t-run-settled", { settledOverride: "settled", settledAt: NOW }),
                shell("t-run-archived", { archivedAt: NOW }),
                // Settled, so its failed run is done with and does not count.
                shell("t-child", {
                  status: "failed",
                  settledOverride: "settled",
                  settledAt: NOW,
                }),
              ],
            }),
          ),
        );

        assert.deepStrictEqual(result.factory.scheduledTaskIds, [nightly.id]);
        assert.deepStrictEqual(result.factory.threads, [
          { threadId: ThreadId.make("t-foreman"), role: "foreman" },
          { threadId: ThreadId.make("t-child"), role: "implement" },
          { threadId: ThreadId.make("t-run"), role: null },
        ]);
        assert.deepStrictEqual(result.factory.attention, {
          gatesWaiting: 1,
          failedRuns: 3,
          questions: 1,
          total: 5,
        });
        assert.deepStrictEqual(
          result.factory.issues.map((issue) => issue.code),
          ["unknown_scheduled_task"],
        );
        assert.deepStrictEqual(result.list.factories[0]?.threadIds, [
          ThreadId.make("t-foreman"),
          ThreadId.make("t-child"),
          ThreadId.make("t-run"),
        ]);
        assert.deepStrictEqual(result.list.factories[0]?.attention, result.factory.attention);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("deletes a factory's directory and ledger and leaves its scheduled tasks", () =>
    Effect.gen(function* () {
      const nightly = task("scheduled-task:nightly");
      const root = yield* checkout({
        ".t3/factories/triage/factory.json": factoryJson({
          name: "triage",
          triggers: [{ kind: "scheduled_task", scheduledTaskId: nightly.id }],
        }),
        ".t3/factories/triage/roles/review.md": "---\n---\n\nReview it.\n",
        ".t3/factories/other/factory.json": factoryJson({ name: "other" }),
      });
      const backend = project("project-backend", "backend", root);
      const factoryId = makeFactoryId(backend.projectId, "triage");
      const otherId = makeFactoryId(backend.projectId, "other");
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const result = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const factories = yield* FactoryService.FactoryService;
        for (const [owner, suffix] of [
          [factoryId, "mine"],
          [otherId, "theirs"],
        ] as const) {
          yield* sql`
            INSERT INTO fork_factory_threads (factory_id, thread_id, role, created_at)
            VALUES (${owner}, ${`t-${suffix}`}, 'foreman', '2026-11-01T00:00:00.000Z')
          `;
          yield* sql`
            INSERT INTO fork_factory_work_items (
              work_item_id, factory_id, title, source_json, stage, gate_json,
              foreman_thread_id, foreman_run_id, created_at, updated_at
            ) VALUES (
              ${`work-item:${suffix}`}, ${owner}, 'Fix it', '{"kind":"manual","text":"Fix it."}',
              'implement', '{"state":"none"}', ${`t-${suffix}`}, NULL,
              '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'
            )
          `;
          yield* sql`
            INSERT INTO fork_factory_work_item_threads (work_item_id, thread_id, role, created_at)
            VALUES (${`work-item:${suffix}`}, ${`t-child-${suffix}`}, 'implement',
              '2026-11-01T00:00:00.000Z')
          `;
          yield* sql`
            INSERT INTO fork_factory_work_item_transitions (
              transition_id, work_item_id, from_stage, to_stage, actor_json, note, at
            ) VALUES (${`x-${suffix}`}, ${`work-item:${suffix}`}, 'new', 'implement',
              '{"kind":"user","userId":null}', NULL, '2026-11-01T00:00:00.000Z')
          `;
        }

        // The mocked ScheduledTaskService has no delete, so a call to it fails this test.
        const deleted = yield* factories.delete(factoryId);
        const missing = yield* factories.delete(factoryId).pipe(Effect.flip);
        const count = (table: string) =>
          sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`.pipe(
            Effect.map((rows) => rows[0]?.n),
          );
        return {
          deleted,
          missing,
          listed: (yield* factories.list()).factories.map((factory) => factory.id),
          rows: {
            threads: yield* count("fork_factory_threads"),
            items: yield* count("fork_factory_work_items"),
            itemThreads: yield* count("fork_factory_work_item_threads"),
            transitions: yield* count("fork_factory_work_item_transitions"),
          },
        };
      }).pipe(Effect.provide(layerFor({ projects: [backend], tasks: [nightly] })));

      assert.deepStrictEqual(result.deleted, { factoryId });
      assert.strictEqual(result.missing.code, "not_found");
      assert.isFalse(yield* fileSystem.exists(path.join(root, ".t3/factories/triage")));
      assert.deepStrictEqual(result.listed, [otherId]);
      // Only the other factory's row is left in each table.
      assert.deepStrictEqual(result.rows, { threads: 1, items: 1, itemThreads: 1, transitions: 1 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

const foremanAdapter = {
  instanceId: codex,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Work item tests open no provider session"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

interface Recorded {
  readonly launches: Ref.Ref<
    ReadonlyArray<{
      readonly input: ThreadLaunchService.ThreadLaunchInput;
      /** The thread's fork_factory_threads role when the launch began. */
      readonly listedAs: string | null;
    }>
  >;
  readonly sends: Ref.Ref<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>;
  /** Whether the checkout's Git resolves a committer identity. */
  readonly gitIdentity: Ref.Ref<boolean>;
}

/** Creates the thread through the real orchestrator, without workspace preparation. */
const layerRecordedLaunch = (recorded: Recorded) =>
  Layer.effect(
    ThreadLaunchService.ThreadLaunchService,
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      return ThreadLaunchService.ThreadLaunchService.of({
        launch: (launch) =>
          Effect.gen(function* () {
            const threadId = launch.threadId!;
            const rows = yield* sql<{ readonly role: string }>`
              SELECT role FROM fork_factory_threads WHERE thread_id = ${threadId}
            `;
            yield* Ref.update(recorded.launches, (all) => [
              ...all,
              { input: launch, listedAs: rows[0]?.role ?? null },
            ]);
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: launch.commandId,
              threadId,
              projectId: launch.projectId,
              title: launch.title,
              modelSelection: launch.modelSelection,
              runtimeMode: launch.runtimeMode,
              interactionMode: launch.interactionMode,
              branch: null,
              worktreePath: null,
              createdBy: launch.createdBy,
              creationSource: launch.creationSource,
              // As the real launch does, the first message's run waits for its workspace.
              ...(launch.initialMessage === undefined
                ? {}
                : {
                    initialMessage: {
                      ...launch.initialMessage,
                      messageId: launch.initialMessage.messageId!,
                      workspaceStrategy: launch.workspaceStrategy,
                    },
                  }),
            });
            const projection = yield* orchestrator.getThreadProjection(threadId);
            return { threadId, projection, resumed: false };
          }).pipe(Effect.orDie),
        checkWorktreeBase: () => Effect.die("unused"),
        isNonGitProject: () => Effect.succeed(false),
        retryPreparation: () => Effect.die("unused"),
        prepareRun: () => Effect.die("unused"),
      });
    }),
  );

/** The real thread management service, with every send recorded. */
const layerRecordedSends = (recorded: Recorded) =>
  Layer.effect(
    ThreadManagementService.ThreadManagementService,
    Effect.map(ThreadManagementService.ThreadManagementService, (threads) =>
      ThreadManagementService.ThreadManagementService.of({
        ...threads,
        sendToThread: (input) =>
          Ref.update(recorded.sends, (all) => [...all, input]).pipe(
            Effect.andThen(threads.sendToThread(input)),
          ),
      }),
    ),
  );

const layerOrchestration = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  ProviderReplayHarness.layerWithRegistry(
    { name: "factory-work-items" },
    ProviderAdapterRegistry.layerFromAdapters([foremanAdapter]),
    { databaseLayer: SqlitePersistence.layerMemory, runEffectWorker: false },
  ),
);

/** Real orchestration and thread management; the launch, Git, and catalogs are fake. */
const layerWorkItems = (backend: ProjectStore.ProjectRow, recorded: Recorded) =>
  FactoryService.layer.pipe(
    Layer.provide(layerSkillStore()),
    Layer.provide(layerRecordedLaunch(recorded)),
    Layer.provide(layerRecordedSends(recorded)),
    Layer.provide(ThreadManagementService.layer),
    Layer.provide(CommandReceiptStore.layer),
    Layer.provide(ServerSettings.layerTest({})),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectStore.ProjectStoreV2)({
          list: () => Effect.succeed([backend]),
          get: (projectId) =>
            Effect.succeed(projectId === backend.projectId ? Option.some(backend) : Option.none()),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          resolveCommit: () => Effect.succeed({ commitSha: "c0ffee" }),
          // Git with only user.name set, as `git var` and `git config --get` answer.
          execute: (input) =>
            Effect.map(Ref.get(recorded.gitIdentity), (identity) => {
              const found = identity || input.args.includes("user.name");
              return {
                exitCode: ChildProcessSpawner.ExitCode(
                  found ? 0 : input.args[0] === "var" ? 128 : 1,
                ),
                stdout: found ? "Ada <ada@example.com> 1700000000 +0000\n" : "",
                stderr: found
                  ? ""
                  : "*** Please tell me who you are.\n\nfatal: unable to auto-detect email address (got 'root@host.(none)')\n",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
    Layer.provideMerge(layerOrchestration),
    Layer.provideMerge(NodeServices.layer),
  );

const runs = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadRecords(threadId, ["runs"]).pipe(Effect.map((records) => records.runs)),
  );

const otherThread = ThreadId.make("thread-not-the-foreman");

/** A factory named triage in a fresh checkout, with the services a work item test drives. */
const withWorkItems = <A, E>(
  test: (input: {
    readonly factoryId: ReturnType<typeof makeFactoryId>;
    readonly recorded: Recorded;
  }) => Effect.Effect<
    A,
    E,
    FactoryService.FactoryService | Orchestrator.OrchestratorV2 | SqlClient.SqlClient
  >,
  options: {
    readonly defaultModel?: boolean;
    /** More files in the checkout, relative to the factory directory. */
    readonly files?: Record<string, string>;
  } = {},
) =>
  Effect.gen(function* () {
    const root = yield* checkout({
      ".t3/factories/triage/factory.json": factoryJson({ name: "triage" }),
      ...Object.fromEntries(
        Object.entries(options.files ?? {}).map(([relative, text]) => [
          `.t3/factories/triage/${relative}`,
          text,
        ]),
      ),
    });
    const backend = {
      ...project("project-backend", "backend", root),
      defaultModelSelection:
        options.defaultModel === false ? null : { instanceId: codex, model: "gpt-6" },
    };
    const recorded: Recorded = {
      launches: yield* Ref.make<Recorded["launches"] extends Ref.Ref<infer A> ? A : never>([]),
      sends: yield* Ref.make<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>([]),
      gitIdentity: yield* Ref.make(true),
    };
    return yield* test({ factoryId: makeFactoryId(backend.projectId, "triage"), recorded }).pipe(
      Effect.provide(layerWorkItems(backend, recorded)),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("FactoryService work items", () => {
  it.effect(
    "creates an item and launches its own Foreman thread with the item as its message",
    () =>
      withWorkItems(({ factoryId, recorded }) =>
        Effect.gen(function* () {
          const factories = yield* FactoryService.FactoryService;
          const item = yield* factories.createWorkItem({
            factoryId,
            title: "Fix the login bug",
            text: "Users cannot sign in with SSO.",
          });

          const [launch] = yield* Ref.get(recorded.launches);
          const foremanThreadId = launch!.input.threadId!;
          assert.strictEqual(foremanThreadId, `factory-foreman:${item.id}`);
          assert.strictEqual(launch!.input.commandId, `factory-foreman-launch:${item.id}`);
          assert.strictEqual(launch!.listedAs, "foreman");
          assert.strictEqual(launch!.input.title, "Fix the login bug");
          assert.deepStrictEqual(launch!.input.workspaceStrategy, { type: "root" });
          assert.deepStrictEqual(launch!.input.modelSelection, {
            instanceId: codex,
            model: "gpt-6",
          });
          assert.strictEqual(launch!.input.createdBy, "agent");
          assert.strictEqual(launch!.input.creationSource, "server");
          const text = launch!.input.initialMessage?.text ?? "";
          assert.include(text, item.id);
          assert.include(text, "Users cannot sign in with SSO.");
          assert.include(text, "t3_work_item_advance");
          assert.lengthOf(yield* Ref.get(recorded.sends), 0);

          const [run] = yield* runs(foremanThreadId);
          assert.strictEqual(item.foremanRunId, run!.id);
          assert.strictEqual(item.foremanThreadId, foremanThreadId);
          assert.isNotNull(item.dispatchedAt);
          assert.isNull(item.failureDismissedAt);
          assert.strictEqual(item.stage, "new");
          assert.deepStrictEqual(item.source, {
            kind: "manual",
            text: "Users cannot sign in with SSO.",
          });
        }),
      ),
  );

  it.effect("starts a Foreman bound to a worktree on its item once the worktree is ready", () =>
    withWorkItems(
      ({ factoryId, recorded }) =>
        Effect.gen(function* () {
          const factories = yield* FactoryService.FactoryService;
          const item = yield* factories.createWorkItem({
            factoryId,
            title: "Fix the login bug",
            text: "Users cannot sign in with SSO.",
          });
          const foreman = item.foremanThreadId!;

          // A send right after the launch would start the turn in the project checkout, and
          // binding the worktree a moment later would interrupt it.
          const [run] = yield* runs(foreman);
          assert.strictEqual(item.foremanRunId, run!.id);
          assert.strictEqual(run!.status, "preparing");
          assert.deepStrictEqual(run!.workspacePreparation, {
            type: "worktree",
            baseRef: "c0ffee",
            startFromOrigin: false,
          });
          assert.lengthOf(yield* Ref.get(recorded.sends), 0);
          const [launch] = yield* Ref.get(recorded.launches);
          assert.include(launch!.input.initialMessage?.text, item.id);

          const implementer = ThreadId.make("thread-implementer");
          yield* factories.attachDelegatedChild({
            parentThreadId: foreman,
            childThreadId: implementer,
            taskRole: "implementation",
          });
          assert.deepStrictEqual((yield* factories.readWorkItem(item.id)).threads, [
            { threadId: implementer, role: "implement" },
          ]);
        }),
      { files: { "roles/foreman.md": "---\nisolation: worktree\n---\n" } },
    ),
  );

  it.effect("runs items created together at once, each in its own Foreman thread", () =>
    withWorkItems(({ factoryId, recorded }) =>
      Effect.gen(function* () {
        const factories = yield* FactoryService.FactoryService;
        const [first, second] = yield* Effect.all(
          [
            factories.createWorkItem({ factoryId, title: "One", text: "One." }),
            factories.createWorkItem({ factoryId, title: "Two", text: "Two." }),
          ],
          { concurrency: "unbounded" },
        );

        assert.deepStrictEqual([first!.stage, second!.stage], ["new", "new"]);
        assert.notStrictEqual(first!.foremanThreadId, second!.foremanThreadId);
        assert.deepStrictEqual(
          (yield* Ref.get(recorded.launches))
            .map((launch) => launch.input.threadId ?? null)
            .toSorted(),
          [first!.foremanThreadId, second!.foremanThreadId].toSorted(),
        );
        for (const item of [first!, second!]) {
          assert.isNotNull(item.dispatchedAt);
          assert.deepStrictEqual(
            (yield* runs(item.foremanThreadId!)).map((run) => run.id),
            [item.foremanRunId],
          );
        }
      }),
    ),
  );

  it.effect("starts items left at new without a run, once, when pending items are dispatched", () =>
    withWorkItems(({ factoryId, recorded }) =>
      Effect.gen(function* () {
        const factories = yield* FactoryService.FactoryService;
        const sql = yield* SqlClient.SqlClient;
        const started = yield* factories.createWorkItem({ factoryId, title: "On", text: "On." });
        // As fork migration 024 leaves a queued item, or a crash between insert and launch.
        yield* sql`
          INSERT INTO fork_factory_work_items (
            work_item_id, factory_id, title, source_json, stage, gate_json,
            foreman_thread_id, foreman_run_id, dispatched_at, created_at, updated_at
          ) VALUES (
            'work-item:left', ${factoryId}, 'Left', '{"kind":"manual","text":"Left."}', 'new',
            '{"state":"none"}', NULL, NULL, NULL, '2026-11-01T00:00:00.000Z',
            '2026-11-01T00:00:00.000Z'
          )
        `;

        yield* factories.dispatchPending;
        yield* factories.dispatchPending;

        const left = yield* factories.readWorkItem(WorkItemId.make("work-item:left"));
        assert.strictEqual(left.foremanThreadId, "factory-foreman:work-item:left");
        assert.isNotNull(left.dispatchedAt);
        assert.deepStrictEqual(
          (yield* Ref.get(recorded.launches)).map((launch) => launch.input.threadId ?? null),
          [started.foremanThreadId, left.foremanThreadId],
        );
      }),
    ),
  );

  it.effect("creates items from Jira query events, each started at once", () =>
    withWorkItems(({ factoryId, recorded }) =>
      Effect.gen(function* () {
        const factories = yield* FactoryService.FactoryService;
        const source = (key: string): WorkItemTriggerSource => ({
          kind: "trigger",
          triggerId: ScheduledTaskId.make("task:jira-query"),
          title: "Agent-labelled issues",
          event: {
            source: "jira_query",
            type: "issue.entered",
            triggerId: ScheduledTaskId.make("task:jira-query"),
            occurredAt: "2026-11-07T09:00:00.000Z",
            payload: {
              type: "issue.entered",
              site: "acme.atlassian.net",
              key,
              projectKey: "PROJ",
              url: `https://acme.atlassian.net/browse/${key}`,
              summary: "Fix login",
              status: "To Do",
              statusCategory: "todo",
              previousStatus: null,
              previousStatusCategory: null,
              issueType: "Bug",
              priority: null,
              assignee: null,
              assigneeAccountId: null,
              previousAssigneeAccountId: null,
              labels: ["agent"],
              addedLabels: [],
              removedLabels: [],
              changedFields: [],
              query: "labels = agent",
            },
          },
          text: `Issue key: ${key}\nSummary: Fix login`,
        });
        const first = yield* factories.createWorkItemFromTrigger({
          factoryId,
          title: "issue.entered PROJ-7: Fix login",
          source: source("PROJ-7"),
        });
        assert.strictEqual(first.stage, "new");
        assert.deepStrictEqual(first.source, source("PROJ-7"));
        const [launch] = yield* Ref.get(recorded.launches);
        assert.include(
          launch!.input.initialMessage?.text,
          "from trigger Agent-labelled issues (jira_query)",
        );
        assert.include(launch!.input.initialMessage?.text, "Issue key: PROJ-7");

        const second = yield* factories.createWorkItemFromTrigger({
          factoryId,
          title: "issue.entered PROJ-8: Fix login",
          source: source("PROJ-8"),
        });
        assert.strictEqual(second.stage, "new");
        assert.isNotNull(second.dispatchedAt);
        assert.deepStrictEqual((yield* factories.readWorkItem(second.id)).source, source("PROJ-8"));
        assert.lengthOf(yield* Ref.get(recorded.launches), 2);
      }),
    ),
  );

  it.effect("keeps an item the Foreman could not be started for, failed by the server", () =>
    withWorkItems(
      ({ factoryId, recorded }) =>
        Effect.gen(function* () {
          const factories = yield* FactoryService.FactoryService;
          const error = yield* factories
            .createWorkItem({ factoryId, title: "Fix", text: "Fix it." })
            .pipe(Effect.flip);
          assert.strictEqual(error._tag === "WorkItemError" && error.code, "unavailable");
          assert.lengthOf(yield* Ref.get(recorded.launches), 0);

          const [summary] = (yield* factories.listWorkItems({ factoryId })).workItems;
          const item = yield* factories.readWorkItem(summary!.id);
          assert.strictEqual(item.stage, "failed");
          assert.deepStrictEqual(
            item.transitions.map(({ from, to, actor }) => ({ from, to, actor })),
            [{ from: "new", to: "failed", actor: { kind: "server" } }],
          );
          assert.include(item.transitions[0]!.note, "has no default model");
          // A failed item is not pending, so dispatching pending items leaves it failed.
          yield* factories.dispatchPending;
          assert.lengthOf(yield* Ref.get(recorded.launches), 0);
        }),
      { defaultModel: false },
    ),
  );

  it.effect("lets a person dismiss a failed item's failure and restore it", () =>
    withWorkItems(({ factoryId }) =>
      Effect.gen(function* () {
        const factories = yield* FactoryService.FactoryService;
        const item = yield* factories.createWorkItem({ factoryId, title: "Fix", text: "Fix it." });
        const userId = AuthUserId.make("user-ada");
        const notFailed = yield* factories
          .setWorkItemFailureDismissed(userId, { workItemId: item.id, dismissed: true })
          .pipe(Effect.flip);
        assert.strictEqual(notFailed._tag === "WorkItemError" && notFailed.code, "not_failed");

        yield* factories.advanceWorkItem(item.foremanThreadId!, {
          workItemId: item.id,
          stage: "failed",
        });
        assert.strictEqual((yield* factories.read(factoryId)).attention.failedRuns, 1);
        const dismissed = yield* factories.setWorkItemFailureDismissed(userId, {
          workItemId: item.id,
          dismissed: true,
        });
        assert.strictEqual(dismissed.stage, "failed");
        assert.isNotNull(dismissed.failureDismissedAt);
        assert.strictEqual((yield* factories.read(factoryId)).attention.failedRuns, 0);
        assert.deepStrictEqual(
          (yield* factories.listWorkItems({ factoryId, outcome: "failed" })).workItems.map(
            (listed) => listed.id,
          ),
          [item.id],
        );

        const restored = yield* factories.setWorkItemFailureDismissed(userId, {
          workItemId: item.id,
          dismissed: false,
        });
        assert.isNull(restored.failureDismissedAt);
        assert.strictEqual((yield* factories.read(factoryId)).attention.failedRuns, 1);
        assert.deepStrictEqual(
          restored.transitions
            .slice(-2)
            .map(({ from, to, actor, note }) => ({ from, to, actor, note })),
          [
            {
              from: "failed",
              to: "failed",
              actor: { kind: "user", userId },
              note: "Dismissed the failure.",
            },
            {
              from: "failed",
              to: "failed",
              actor: { kind: "user", userId },
              note: "Restored the failure.",
            },
          ],
        );
      }),
    ),
  );

  it.effect("lets only the item's Foreman advance it, along the transition table", () =>
    withWorkItems(({ factoryId }) =>
      Effect.gen(function* () {
        const factories = yield* FactoryService.FactoryService;
        const item = yield* factories.createWorkItem({ factoryId, title: "Fix", text: "Fix it." });
        const foreman = item.foremanThreadId!;
        const child = ThreadId.make("thread-implementer");

        const denied = yield* factories
          .advanceWorkItem(otherThread, { workItemId: item.id, stage: "implement" })
          .pipe(Effect.flip);
        assert.strictEqual(denied._tag === "WorkItemError" && denied.code, "not_foreman");

        yield* factories.advanceWorkItem(foreman, {
          workItemId: item.id,
          stage: "implement",
          note: "Delegated the fix.",
          threads: [{ threadId: child, role: "implement" }],
        });
        const refused = yield* factories
          .advanceWorkItem(foreman, { workItemId: item.id, stage: "done" })
          .pipe(Effect.flip);
        assert.deepStrictEqual(
          refused._tag === "WorkItemTransitionError" && [refused.from, refused.to],
          ["implement", "done"],
        );
        // The same stage only names another thread.
        const reviewer = ThreadId.make("thread-reviewer");
        const named = yield* factories.advanceWorkItem(foreman, {
          workItemId: item.id,
          stage: "implement",
          threads: [{ threadId: reviewer, role: null }],
        });

        assert.strictEqual(named.stage, "implement");
        assert.deepStrictEqual(named.threads, [
          { threadId: child, role: "implement" },
          { threadId: reviewer, role: null },
        ]);
        assert.deepStrictEqual(
          named.transitions.map(({ from, to, actor, note }) => ({ from, to, actor, note })),
          [
            {
              from: "new",
              to: "implement",
              actor: { kind: "foreman", threadId: foreman },
              note: "Delegated the fix.",
            },
          ],
        );
        const listed = yield* factories.listWorkItems({ factoryId, role: "implement" });
        assert.deepStrictEqual(
          listed.workItems.map((workItem) => workItem.id),
          [item.id],
        );
        const done = yield* factories.listWorkItems({ factoryId, outcome: "done" });
        assert.deepStrictEqual(done.workItems, []);
      }),
    ),
  );

  it.effect("holds a gated item for a person, then resumes it and tells the Foreman", () =>
    withWorkItems(({ factoryId, recorded }) =>
      Effect.gen(function* () {
        const factories = yield* FactoryService.FactoryService;
        const item = yield* factories.createWorkItem({ factoryId, title: "Fix", text: "Fix it." });
        const foreman = item.foremanThreadId!;
        yield* factories.advanceWorkItem(foreman, { workItemId: item.id, stage: "implement" });

        const gated = yield* factories.gateWorkItem(foreman, {
          workItemId: item.id,
          question: "Ship the schema change?",
          resumeStage: "review",
        });
        assert.strictEqual(gated.stage, "waiting");
        const held = yield* factories
          .advanceWorkItem(foreman, { workItemId: item.id, stage: "failed" })
          .pipe(Effect.flip);
        assert.strictEqual(held._tag === "WorkItemError" && held.code, "gate_waiting");
        const notForeman = yield* factories
          .gateWorkItem(otherThread, { workItemId: item.id, question: "?", resumeStage: "done" })
          .pipe(Effect.flip);
        assert.strictEqual(notForeman._tag === "WorkItemError" && notForeman.code, "not_foreman");

        const answered = yield* factories.answerWorkItemGate(null, {
          workItemId: item.id,
          decision: "approved",
          note: "Go ahead.",
        });
        assert.strictEqual(answered.stage, "review");
        assert.deepStrictEqual(answered.gate, {
          state: "answered",
          question: "Ship the schema change?",
          decision: "approved",
          note: "Go ahead.",
          answeredAt: answered.gate.state === "answered" ? answered.gate.answeredAt : "",
          resumeStage: "review",
        });
        assert.deepStrictEqual(answered.transitions.at(-1)?.actor, { kind: "user", userId: null });

        const followUp = (yield* Ref.get(recorded.sends)).at(-1)!;
        assert.strictEqual(followUp.threadId, foreman);
        assert.strictEqual(followUp.mode, "auto");
        assert.isUndefined(followUp.freshContext);
        assert.include(followUp.text, "approved");
        assert.include(followUp.text, "Go ahead.");

        const again = yield* factories
          .answerWorkItemGate(null, { workItemId: item.id, decision: "approved", note: "" })
          .pipe(Effect.flip);
        assert.strictEqual(again._tag === "WorkItemError" && again.code, "no_gate");

        // A rejection drops the item.
        yield* factories.gateWorkItem(foreman, {
          workItemId: item.id,
          question: "Merge it?",
          resumeStage: "done",
        });
        const rejected = yield* factories.answerWorkItemGate(null, {
          workItemId: item.id,
          decision: "rejected",
          note: "",
        });
        assert.strictEqual(rejected.stage, "dropped");
        assert.include((yield* Ref.get(recorded.sends)).at(-1)!.text, "Stop work on it");
      }),
    ),
  );

  it.effect("names a delegated child on the item its Foreman thread runs", () =>
    withWorkItems(({ factoryId }) =>
      Effect.gen(function* () {
        const factories = yield* FactoryService.FactoryService;
        const first = yield* factories.createWorkItem({ factoryId, title: "One", text: "One." });
        const second = yield* factories.createWorkItem({ factoryId, title: "Two", text: "Two." });
        const implementer = ThreadId.make("thread-implementer");
        const reviewer = ThreadId.make("thread-reviewer");
        yield* factories.attachDelegatedChild({
          parentThreadId: first.foremanThreadId!,
          childThreadId: implementer,
          taskRole: "implementation",
        });
        yield* factories.attachDelegatedChild({
          parentThreadId: second.foremanThreadId!,
          childThreadId: reviewer,
          taskRole: "review",
        });
        yield* factories.attachDelegatedChild({
          parentThreadId: otherThread,
          childThreadId: ThreadId.make("thread-unrelated"),
          taskRole: "implementation",
        });
        // Once its item ends, the Foreman thread's children belong to no item.
        yield* factories.advanceWorkItem(first.foremanThreadId!, {
          workItemId: first.id,
          stage: "dropped",
        });
        yield* factories.attachDelegatedChild({
          parentThreadId: first.foremanThreadId!,
          childThreadId: ThreadId.make("thread-late"),
          taskRole: "review",
        });

        assert.deepStrictEqual((yield* factories.readWorkItem(first.id)).threads, [
          { threadId: implementer, role: "implement" },
        ]);
        assert.deepStrictEqual((yield* factories.readWorkItem(second.id)).threads, [
          { threadId: reviewer, role: "review" },
        ]);
      }),
    ),
  );
  it.effect("gives a Foreman's delegated child its role's binding over the call's arguments", () =>
    withWorkItems(
      ({ factoryId }) =>
        Effect.gen(function* () {
          const factories = yield* FactoryService.FactoryService;
          const item = yield* factories.createWorkItem({
            factoryId,
            title: "Fix",
            text: "Fix it.",
          });
          const foreman = item.foremanThreadId!;
          const prepare = (
            parentThreadId: ThreadId,
            delegation: FactoryService.FactoryDelegation,
          ) => factories.prepareDelegation({ parentThreadId, delegation });

          // The trial: the Foreman passes no isolation, and the implement role binds a worktree.
          const implement = yield* prepare(foreman, { task: "Fix it.", role: "implementation" });
          assert.deepStrictEqual(implement, {
            task: "Fix it.",
            role: "implementation",
            isolation: "worktree",
            runtimeMode: "full-access",
            interactionMode: "default",
          });

          const review = yield* prepare(foreman, {
            task: "Review it.",
            role: "review",
            isolation: "worktree",
            runtimeMode: "approval-required",
            target: { providerInstanceId: ProviderInstanceId.make("claude"), model: "haiku" },
          });
          assert.deepStrictEqual(review, {
            task: "Review it.",
            role: "review",
            isolation: "shared",
            runtimeMode: "full-access",
            interactionMode: "default",
            target: { providerInstanceId: codex, model: "gpt-6", options: [] },
          });

          // A role with no binding, and a thread no factory owns, keep the call as it is.
          const research = { task: "Look around.", role: "research", isolation: "shared" } as const;
          assert.deepStrictEqual(yield* prepare(foreman, research), research);
          const unowned = { task: "Fix it.", role: "implementation" } as const;
          assert.deepStrictEqual(yield* prepare(otherThread, unowned), unowned);

          const logged = (yield* factories.readWorkItem(item.id)).transitions;
          assert.deepStrictEqual(
            logged.map(({ from, to, actor }) => ({ from, to, actor })),
            [
              { from: "new", to: "new", actor: { kind: "server" } },
              { from: "new", to: "new", actor: { kind: "server" } },
            ],
          );
          assert.strictEqual(
            logged[0]!.note,
            "Applied the implement role's binding to a delegated task: isolation worktree, runtime mode full-access, interaction mode default.",
          );
          assert.strictEqual(
            logged[1]!.note,
            "Applied the review role's binding to a delegated task: isolation shared, runtime mode full-access, interaction mode default, model codex/gpt-6. It replaced the call's isolation worktree, runtime mode approval-required, model claude/haiku.",
          );
        }),
      {
        files: {
          "roles/review.md":
            "---\nisolation: shared\nmodel:\n  instanceId: codex\n  model: gpt-6\n---\n",
        },
      },
    ),
  );
  it.effect("holds an item at a gate when its checkout has no Git identity, until it has one", () =>
    withWorkItems(({ factoryId, recorded }) =>
      Effect.gen(function* () {
        const factories = yield* FactoryService.FactoryService;
        yield* Ref.set(recorded.gitIdentity, false);
        const item = yield* factories.createWorkItem({ factoryId, title: "Fix", text: "Fix it." });
        const delegate = factories.prepareDelegation({
          parentThreadId: item.foremanThreadId!,
          delegation: { task: "Fix it.", role: "implementation" },
        });

        const held = yield* delegate.pipe(Effect.flip);
        assert.strictEqual(held._tag === "WorkItemError" && held.code, "gate_waiting");
        const gated = yield* factories.readWorkItem(item.id);
        assert.strictEqual(gated.stage, "waiting");
        assert.deepStrictEqual(
          gated.transitions.map(({ from, to, actor }) => ({ from, to, actor })),
          [{ from: "new", to: "waiting", actor: { kind: "server" } }],
        );
        const question = gated.gate.state === "waiting" ? gated.gate.question : "";
        assert.include(question, "user.email");
        assert.notInclude(question, "user.name");
        assert.include(question, "unable to auto-detect email address");
        assert.include(held.message, question);

        yield* Ref.set(recorded.gitIdentity, true);
        const answered = yield* factories.answerWorkItemGate(null, {
          workItemId: item.id,
          decision: "approved",
          note: "Set it.",
        });
        assert.strictEqual(answered.stage, "implement");
        const bound = yield* delegate;
        assert.strictEqual(bound.isolation, "worktree");
      }),
    ),
  );
});
