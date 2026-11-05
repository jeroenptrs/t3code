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

import { taskPrompt } from "../mcp/delegatedTaskModes.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
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

it.effect("gives a factory's threads and its Foreman's delegated children their role body", () =>
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
    const projectId = ProjectId.make("project-backend");
    const factoryId = makeFactoryId(projectId, "triage");
    const backend = { projectId, workspaceRoot: root } as ProjectStore.ProjectRow;

    const roles = yield* Effect.gen(function* () {
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
      return yield* Effect.forEach(
        [
          "t-foreman",
          "t-implement",
          "t-review",
          "t-other",
          "t-foreman-implementer",
          "t-foreman-reviewer",
          "t-foreman-helper",
          "t-other-implementer",
        ],
        (id) => threads.roleOf(ThreadId.make(id)),
      );
    }).pipe(
      Effect.provide(
        FactoryThreads.layer.pipe(
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

    assert.deepStrictEqual(roles, [
      { factoryId, role: "foreman", body: "Route only bugs." },
      { factoryId, role: "implement", body: builtinRoles.implement.body },
      { factoryId, role: "review", body: "Block on any failing check." },
      null,
      // A Foreman's children take the role their task asked for, from the same role files.
      { factoryId, role: "implement", body: builtinRoles.implement.body },
      { factoryId, role: "review", body: "Block on any failing check." },
      null,
      null,
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
