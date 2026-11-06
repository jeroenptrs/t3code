import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  makeFactoryId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpTaskRole,
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
import { taskPrompt } from "../mcp/delegatedTaskModes.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { builtinSkillEntries } from "./factoryFiles.ts";
import * as FactorySkillStore from "./FactorySkillStore.ts";
import * as FactoryThreads from "./FactoryThreads.ts";
import { builtinRoles } from "./roles/index.ts";

const factoryJson = JSON.stringify({ name: "triage", roles: { review: "roles/strict-review.md" } });

/** Children delegated from `parent`, each from its own task node, as the projection holds them. */
const delegated = (
  parent: string,
  children: ReadonlyArray<readonly [child: string, role: OrchestratorMcpTaskRole]>,
) =>
  children.map(([child, role]) => ({
    parent: ThreadId.make(parent),
    child: ThreadId.make(child),
    nodeId: NodeId.make(`node:${child}`),
    prompt: taskPrompt({ task: "Fix the login bug.", role }),
  }));

const children = [
  ...delegated("t-foreman", [
    ["t-foreman-implementer", "implementation"],
    ["t-foreman-reviewer", "review"],
    ["t-foreman-helper", "general"],
  ]),
  ...delegated("t-other", [["t-other-implementer", "implementation"]]),
];

/** Lineage and subagent records for `children`; any other thread is not found. */
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
          forkedFrom: { type: "node", nodeId: found.nodeId },
        } as unknown as OrchestrationV2AppThread);
  },
  getThreadRecords: (threadId, _fields, filter) =>
    Effect.succeed({
      subagents: children
        .filter((entry) => entry.parent === threadId && filter?.subagentIds?.includes(entry.nodeId))
        .map((entry) => ({ id: entry.nodeId, childThreadId: entry.child, prompt: entry.prompt })),
    } as unknown as OrchestrationV2ThreadProjection),
});

it.effect("gives a factory's threads and its Foreman's children their role body and skills", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-factory-threads-" });
    const directory = path.join(root, ".t3", "factories", "triage");
    yield* fileSystem.makeDirectory(path.join(directory, "roles"), { recursive: true });
    yield* fileSystem.writeFileString(path.join(directory, "factory.json"), factoryJson);
    // Foreman's file sits at the default path; review's at the path factory.json names.
    yield* fileSystem.writeFileString(
      path.join(directory, "roles", "foreman.md"),
      "Route only bugs.\n",
    );
    yield* fileSystem.writeFileString(
      path.join(directory, "roles", "strict-review.md"),
      "---\nisolation: shared\n---\n\nBlock on any failing check.\n",
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
      body: builtinRoles.implement.body,
      skills: [{ name: "implement", description: builtinImplement.description }],
    };
    const reviewRole = {
      factoryId,
      role: "review",
      body: "Block on any failing check.",
      skills: [{ name: "review", description: "Triage review." }],
    };
    assert.deepStrictEqual(roles, [
      { factoryId, role: "foreman", body: "Route only bugs.", skills: [] },
      implementRole,
      reviewRole,
      null,
      // A Foreman's children take the role their task asked for, from the same role files.
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
