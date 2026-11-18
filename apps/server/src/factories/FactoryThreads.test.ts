import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  makeFactoryId,
  type OrchestrationV2AppThread,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { builtinSkillEntries } from "./factoryFiles.ts";
import * as FactorySkillStore from "./FactorySkillStore.ts";
import * as FactoryThreads from "./FactoryThreads.ts";
import { rolePresets } from "./roles/index.ts";

const factoryJson = JSON.stringify({
  version: 2,
  name: "triage",
  roles: {
    foreman: "roles/foreman.md",
    implement: null,
    review: "roles/strict-review.md",
    docs: "roles/docs.md",
  },
});

/** Subagent children and the thread that delegated each; any other thread is not found. */
const children = [
  ["t-foreman-implementer", "t-foreman"],
  ["t-foreman-reviewer", "t-foreman"],
  ["t-foreman-helper", "t-foreman"],
  ["t-other-implementer", "t-other"],
].map(([child, parent]) => ({ child: ThreadId.make(child!), parent: ThreadId.make(parent!) }));

const layerProjections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
  getThread: (threadId) => {
    const found = children.find((entry) => entry.child === threadId);
    return found === undefined
      ? Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }))
      : Effect.succeed({
          lineage: {
            parentThreadId: found.parent,
            relationshipToParent: "subagent",
            rootThreadId: found.parent,
          },
        } as unknown as OrchestrationV2AppThread);
  },
});

it.effect("gives a factory's threads and its Foreman's children their role body and skills", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-factory-threads-" });
    const directory = path.join(root, ".t3", "factories", "triage");
    yield* fileSystem.makeDirectory(path.join(directory, "roles"), { recursive: true });
    yield* fileSystem.writeFileString(path.join(directory, "factory.json"), factoryJson);
    // Review's file sits at the path factory.json names, and docs is disabled.
    yield* fileSystem.writeFileString(
      path.join(directory, "roles", "foreman.md"),
      "Route only bugs.\n",
    );
    yield* fileSystem.writeFileString(
      path.join(directory, "roles", "strict-review.md"),
      "---\nisolation: shared\n---\n\nBlock on any failing check.\n",
    );
    yield* fileSystem.writeFileString(
      path.join(directory, "roles", "docs.md"),
      "---\nenabled: false\n---\n\nWrite the docs.\n",
    );
    // Implement keeps the built-in skill. T3 home's review skill replaces the built-in one, and
    // the factory's review skill replaces home's.
    const home = path.join(root, "home");
    for (const [skillDirectory, description] of [
      [path.join(home, "skills", "review"), "Home review."],
      [path.join(directory, "skills", "review"), "Triage review."],
    ] as const) {
      yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(skillDirectory, "SKILL.md"),
        `---\nname: review\ndescription: ${description}\n---\n`,
      );
    }
    const builtinImplement = builtinSkillEntries.find((skill) => skill.name === "implement");
    assert(builtinImplement?.source === "builtin");
    const projectId = ProjectId.make("project-backend");
    const factoryId = makeFactoryId(projectId, "triage");
    const backend = { projectId, workspaceRoot: root } as ProjectStore.ProjectRow;

    const { roles, skills } = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const [threadId, role] of [
        ["t-foreman", "foreman"],
        ["t-implement", "implement"],
        ["t-review", "review"],
      ]) {
        yield* sql`
          INSERT INTO fork_factory_threads (factory_id, thread_id, role, created_at)
          VALUES (${factoryId}, ${threadId}, ${role}, '2026-11-05T00:00:00.000Z')
        `;
      }
      // The Foreman's item is at review now. Its implementer was named when it was at implement,
      // the helper with no role, and the reviewer's row is not written yet.
      yield* sql`
        INSERT INTO fork_factory_work_items (
          work_item_id, factory_id, title, source_json, stage, gate_json,
          foreman_thread_id, foreman_run_id, created_at, updated_at
        ) VALUES (
          'work-item:1', ${factoryId}, 'Fix', '{"kind":"manual","text":"Fix it."}', 'review',
          '{"state":"none"}', 't-foreman', NULL, '2026-11-05T00:00:00.000Z',
          '2026-11-05T00:00:00.000Z'
        )
      `;
      for (const [threadId, role] of [
        ["t-foreman-implementer", "implement"],
        ["t-foreman-helper", null],
      ]) {
        yield* sql`
          INSERT INTO fork_factory_work_item_threads (work_item_id, thread_id, role, created_at)
          VALUES ('work-item:1', ${threadId}, ${role}, '2026-11-05T00:00:00.000Z')
        `;
      }
      const threads = yield* FactoryThreads.FactoryThreads;
      const threadIds = [
        "t-foreman",
        "t-implement",
        "t-review",
        "t-other",
        "t-foreman-implementer",
        "t-foreman-reviewer",
        "t-foreman-helper",
        "t-other-implementer",
      ].map((id) => ThreadId.make(id));
      return {
        roles: yield* Effect.forEach(threadIds, threads.roleOf),
        skills: yield* Effect.forEach(threadIds, threads.skillsOf),
      };
    }).pipe(
      Effect.provide(
        FactoryThreads.layer.pipe(
          Layer.provide(
            FactorySkillStore.layer.pipe(
              Layer.provide(Layer.orDie(ServerConfig.layerTest(root, home))),
            ),
          ),
          Layer.provideMerge(Layer.orDie(SqlitePersistence.layerMemory)),
          Layer.provide(
            Layer.mock(ProjectStore.ProjectStoreV2)({
              get: (id) => Effect.succeed(id === projectId ? Option.some(backend) : Option.none()),
            }),
          ),
          Layer.provide(layerProjections),
        ),
      ),
    );

    // The instructions name the same skills the session gets, with their descriptions.
    const implementRole = {
      factoryId,
      role: "implement",
      body: rolePresets.implement.body,
      skills: [{ name: "implement", description: builtinImplement.description }],
    };
    const reviewRole = {
      factoryId,
      role: "review",
      body: "Block on any failing check.",
      skills: [{ name: "review", description: "Triage review." }],
    };
    assert.deepStrictEqual(roles, [
      // The Foreman is told which roles it can delegate to: not docs, which is disabled.
      {
        factoryId,
        role: "foreman",
        body: "Route only bugs.",
        skills: [],
        delegates: ["implement", "review"],
      },
      implementRole,
      reviewRole,
      null,
      // A Foreman's child takes the role its row names, else the stage its item is at.
      implementRole,
      reviewRole,
      null,
      null,
    ]);
    const implementSkill: FactoryThreads.BoundSkill = {
      name: "implement",
      source: "builtin",
      text: builtinImplement.text,
    };
    const reviewSkill: FactoryThreads.BoundSkill = {
      name: "review",
      source: "factory",
      directory: path.join(directory, "skills", "review"),
    };
    assert.deepStrictEqual(skills, [
      [],
      [implementSkill],
      [reviewSkill],
      [],
      [implementSkill],
      [reviewSkill],
      [],
      [],
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
