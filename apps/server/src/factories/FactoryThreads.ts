/**
 * The role a factory thread runs as, with its instructions and skills as the factory's files say
 * now: the role it was started as, or for a child the Foreman delegated, the role its task asked
 * for. Apart from `FactoryService` because provider sessions read it, and that service launches
 * threads through orchestration, so depending on it would make a layer cycle.
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
  availableSkills,
  defaultRolePath,
  effectiveBinding,
  FACTORIES_DIRECTORY,
  FACTORY_FILE_NAME,
  parseFactoryJson,
  parseRoleFile,
  readFactorySkillNames,
  resolveRoleSkills,
  SKILLS_DIRECTORY,
} from "./factoryFiles.ts";
import { builtinRoles } from "./roles/index.ts";
import { builtinSkills } from "./skills/index.ts";
import { workItemRoleForTask } from "./workItems.ts";

/** A skill a role binds: a built-in skill's SKILL.md, or the factory's own skill directory. */
export type BoundSkill =
  | { readonly name: string; readonly source: "builtin"; readonly text: string }
  | { readonly name: string; readonly source: "file"; readonly directory: string };

export class FactoryThreads extends Context.Service<
  FactoryThreads,
  {
    /**
     * The role `threadId` runs as and its instructions; null for a thread that is neither a
     * factory's nor a role-bearing child of a Foreman, or when the lookup fails, which is logged.
     */
    readonly roleOf: (threadId: ThreadId) => Effect.Effect<FactoryRoleInstructions | null>;
    /**
     * The skills `threadId`'s role binds that exist; empty for a thread with no role, or when the
     * lookup fails, which is logged.
     */
    readonly skillsOf: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<BoundSkill>>;
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

  /**
   * The factory's directory, null when it has no `factory.json`, and the role's file, null when
   * there is none. Built-in values fill in for whatever is null.
   */
  const roleFile = Effect.fn("FactoryThreads.roleFile")(function* (
    factoryId: string,
    role: FactoryRoleName,
  ) {
    const parsed = parseFactoryId(factoryId);
    if (parsed === null) return { directory: null, file: null };
    const project = yield* projects.get(parsed.projectId);
    if (Option.isNone(project)) return { directory: null, file: null };
    const directory = path.join(project.value.workspaceRoot, ...FACTORIES_DIRECTORY, parsed.name);
    const factoryText = yield* readText(path.join(directory, FACTORY_FILE_NAME));
    if (Option.isNone(factoryText)) return { directory: null, file: null };
    const { definition } = parseFactoryJson(parsed.name, factoryText.value);
    const roleText = yield* readText(
      path.join(directory, definition.roles[role] ?? defaultRolePath(role)),
    );
    return {
      directory,
      file: Option.isNone(roleText) ? null : parseRoleFile(role, roleText.value),
    };
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

  const factoryRole = Effect.fn("FactoryThreads.factoryRole")(function* (threadId: ThreadId) {
    const rows = yield* sql<{ readonly factoryId: string; readonly role: string }>`
      SELECT factory_id AS "factoryId", role FROM fork_factory_threads WHERE thread_id = ${threadId}
    `;
    const row = rows[0];
    if (row === undefined) return yield* delegatedRole(threadId);
    return isRoleName(row.role) ? { factoryId: row.factoryId, role: row.role } : null;
  });

  const roleOf: FactoryThreads["Service"]["roleOf"] = Effect.fn("FactoryThreads.roleOf")(
    function* (threadId) {
      const found = yield* factoryRole(threadId);
      if (found === null) return null;
      const { file } = yield* roleFile(found.factoryId, found.role);
      return { ...found, body: file?.body ?? builtinRoles[found.role].body };
    },
    // Instructions are not part of the MCP credential, so a failed lookup only leaves them out.
    Effect.catch((error) =>
      Effect.logWarning("Could not read a factory thread's role instructions", {
        errorTag: error._tag,
      }).pipe(Effect.as(null)),
    ),
  );

  const skillsOf: FactoryThreads["Service"]["skillsOf"] = Effect.fn("FactoryThreads.skillsOf")(
    function* (threadId) {
      const found = yield* factoryRole(threadId);
      if (found === null) return [];
      const { directory, file } = yield* roleFile(found.factoryId, found.role);
      const names = effectiveBinding(builtinRoles[found.role].binding, file?.binding ?? {}).skills;
      const available = availableSkills(
        directory === null ? [] : yield* readFactorySkillNames(fileSystem, path, directory),
      );
      // An unknown name is an issue on the factory's page; the session opens without it.
      return resolveRoleSkills(found.role, names, available).skills.flatMap(
        ({ name, source }): ReadonlyArray<BoundSkill> => {
          if (source === "file" && directory !== null) {
            return [{ name, source, directory: path.join(directory, SKILLS_DIRECTORY, name) }];
          }
          const text = builtinSkills[name];
          return text === undefined ? [] : [{ name, source: "builtin", text }];
        },
      );
    },
    Effect.catch((error) =>
      Effect.logWarning("Could not read a factory thread's skills", {
        errorTag: error._tag,
      }).pipe(Effect.as([])),
    ),
  );

  return FactoryThreads.of({ roleOf, skillsOf });
});

export const layer = Layer.effect(FactoryThreads, make);
