/**
 * The role a factory thread runs as, with its instructions as the role file says now: the role it
 * was started as, or for a child the Foreman delegated, the role its task asked for. Apart from
 * `FactoryService` because provider sessions read it, and that service launches threads through
 * orchestration, so depending on it would make a layer cycle.
 */
import { FactoryRoleName, parseFactoryId, type ThreadId } from "@t3tools/contracts";
import type { FactoryRoleInstructions } from "@t3tools/provider-core/server/mcpSession";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { taskRoleOfPrompt } from "../mcp/delegatedTaskModes.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  defaultRolePath,
  FACTORIES_DIRECTORY,
  FACTORY_FILE_NAME,
  parseFactoryJson,
  parseRoleFile,
} from "./factoryFiles.ts";
import { builtinRoles } from "./roles/index.ts";
import { workItemRoleForTask } from "./workItems.ts";

export class FactoryThreads extends Context.Service<
  FactoryThreads,
  {
    /**
     * The role `threadId` runs as and its instructions; null for a thread that is neither a
     * factory's nor a role-bearing child of a Foreman, or when the lookup fails, which is logged.
     */
    readonly roleOf: (threadId: ThreadId) => Effect.Effect<FactoryRoleInstructions | null>;
  }
>()("t3/factories/FactoryThreads") {}

const isRoleName = Schema.is(FactoryRoleName);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const readText = (filePath: string) =>
    fileSystem.readFileString(filePath).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(error),
      }),
    );

  /** The role file's body when it has one, else the built-in body. */
  const body = Effect.fn("FactoryThreads.body")(function* (
    factoryId: string,
    role: FactoryRoleName,
  ) {
    const builtin = builtinRoles[role].body;
    const parsed = parseFactoryId(factoryId);
    if (parsed === null) return builtin;
    const project = yield* projects.get(parsed.projectId);
    if (Option.isNone(project)) return builtin;
    const directory = path.join(project.value.workspaceRoot, ...FACTORIES_DIRECTORY, parsed.name);
    const factoryText = yield* readText(path.join(directory, FACTORY_FILE_NAME));
    if (Option.isNone(factoryText)) return builtin;
    const { definition } = parseFactoryJson(parsed.name, factoryText.value);
    const roleText = yield* readText(
      path.join(directory, definition.roles[role] ?? defaultRolePath(role)),
    );
    if (Option.isNone(roleText)) return builtin;
    return parseRoleFile(role, roleText.value).body ?? builtin;
  });

  /**
   * A child the Foreman delegated has no row of its own, since writing one would race its first
   * session. Its lineage names the Foreman and the task that spawned it.
   */
  const delegatedRole = Effect.fn("FactoryThreads.delegatedRole")(function* (threadId: ThreadId) {
    const thread = yield* projections.getThread(threadId);
    const parentThreadId = thread.lineage.parentThreadId;
    const forkedFrom = thread.forkedFrom;
    if (
      thread.lineage.relationshipToParent !== "subagent" ||
      parentThreadId === null ||
      forkedFrom?.type !== "node"
    ) {
      return null;
    }
    const [foreman] = yield* sql<{ readonly factoryId: string }>`
      SELECT factory_id AS "factoryId" FROM fork_factory_threads
      WHERE thread_id = ${parentThreadId} AND role = 'foreman'
    `;
    if (foreman === undefined) return null;
    const { subagents } = yield* projections.getThreadRecords(parentThreadId, ["subagents"], {
      subagentIds: [forkedFrom.nodeId],
    });
    const task = subagents.find(
      (candidate) => candidate.id === forkedFrom.nodeId && candidate.childThreadId === threadId,
    );
    const role = task === undefined ? null : workItemRoleForTask(taskRoleOfPrompt(task.prompt));
    return role === null ? null : { factoryId: foreman.factoryId, role };
  });

  const roleOf: FactoryThreads["Service"]["roleOf"] = Effect.fn("FactoryThreads.roleOf")(
    function* (threadId) {
      const rows = yield* sql<{ readonly factoryId: string; readonly role: string }>`
        SELECT factory_id AS "factoryId", role FROM fork_factory_threads WHERE thread_id = ${threadId}
      `;
      const row = rows[0];
      const found =
        row === undefined
          ? yield* delegatedRole(threadId)
          : isRoleName(row.role)
            ? { factoryId: row.factoryId, role: row.role }
            : null;
      if (found === null) return null;
      return { ...found, body: yield* body(found.factoryId, found.role) };
    },
    // Instructions are not part of the MCP credential, so a failed lookup only leaves them out.
    Effect.catch((error) =>
      Effect.logWarning("Could not read a factory thread's role instructions", {
        errorTag: error._tag,
      }).pipe(Effect.as(null)),
    ),
  );

  return FactoryThreads.of({ roleOf });
});

export const layer = Layer.effect(FactoryThreads, make);
