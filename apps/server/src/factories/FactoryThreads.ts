/**
 * The role a factory thread runs as, with its instructions and skills as the factory's files say
 * now: the role it was started as, or for a child the Foreman delegated, the role it was delegated
 * as. Apart from `FactoryService` because provider sessions read it, and that service launches
 * threads through orchestration, so depending on it would make a layer cycle.
 */
import {
  FACTORY_FOREMAN_ROLE,
  FactoryRoleName,
  parseFactoryId,
  type ThreadId,
} from "@t3tools/contracts";
import type { FactoryRoleInstructions } from "@t3tools/provider-core/server/mcpSession";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  effectiveBinding,
  FACTORIES_DIRECTORY,
  readFactoryFiles,
  resolveRoleSkills,
  roleEnabled,
} from "./factoryFiles.ts";
import * as FactorySkillStore from "./FactorySkillStore.ts";
import { roleDefaults } from "./roles/index.ts";

/** A skill a role binds: a built-in skill's SKILL.md, or a home or factory skill directory. */
export type BoundSkill =
  | { readonly name: string; readonly source: "builtin"; readonly text: string }
  | { readonly name: string; readonly source: "home" | "factory"; readonly directory: string };

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
  const skillStore = yield* FactorySkillStore.FactorySkillStore;

  /** The factory's directory and files; none when it has no `factory.json`. */
  const factoryFiles = Effect.fn("FactoryThreads.factoryFiles")(function* (factoryId: string) {
    const parsed = parseFactoryId(factoryId);
    if (parsed === null) return Option.none();
    const project = yield* projects.get(parsed.projectId);
    if (Option.isNone(project)) return Option.none();
    const directory = path.join(project.value.workspaceRoot, ...FACTORIES_DIRECTORY, parsed.name);
    const files = yield* readFactoryFiles(fileSystem, path, directory, parsed.name);
    return Option.map(files, (value) => ({ directory, ...value }));
  });

  /** A child the Foreman delegated has the role its work item names it with, before it starts. */
  const delegatedRole = Effect.fn("FactoryThreads.delegatedRole")(function* (threadId: ThreadId) {
    const [named] = yield* sql<{ readonly factoryId: string; readonly role: string | null }>`
      SELECT w.factory_id AS "factoryId", t.role
      FROM fork_factory_work_item_threads t
      JOIN fork_factory_work_items w ON w.work_item_id = t.work_item_id
      WHERE t.thread_id = ${threadId}
      ORDER BY t.created_at, t.rowid
      LIMIT 1
    `;
    return named !== undefined && named.role !== null && isRoleName(named.role)
      ? { factoryId: named.factoryId, role: named.role }
      : null;
  });

  const factoryRole = Effect.fn("FactoryThreads.factoryRole")(function* (threadId: ThreadId) {
    const rows = yield* sql<{ readonly factoryId: string; readonly role: string }>`
      SELECT factory_id AS "factoryId", role FROM fork_factory_threads WHERE thread_id = ${threadId}
    `;
    const row = rows[0];
    if (row === undefined) return yield* delegatedRole(threadId);
    return isRoleName(row.role) ? { factoryId: row.factoryId, role: row.role } : null;
  });

  /**
   * The role, its file, the skills it binds that exist in binding order, and for the Foreman the
   * enabled roles it can delegate to with what each is for. Defaults fill in for a missing file.
   */
  const boundRole = Effect.fn("FactoryThreads.boundRole")(function* (threadId: ThreadId) {
    const found = yield* factoryRole(threadId);
    if (found === null) return null;
    const files = yield* factoryFiles(found.factoryId);
    const roles = Option.match(files, { onNone: () => [], onSome: (value) => value.roles });
    const file = roles.find((entry) => entry.role === found.role)?.file ?? null;
    const defaults = roleDefaults(found.role);
    const names = effectiveBinding(defaults.binding, file?.binding ?? {}).skills;
    const available = yield* skillStore.resolve(
      Option.match(files, { onNone: () => null, onSome: (value) => value.directory }),
    );
    // An unknown name is an issue on the factory's page; the session opens without it.
    const { skills } = resolveRoleSkills(found.role, names, available);
    const delegates =
      found.role === FACTORY_FOREMAN_ROLE
        ? roles
            .filter(
              (entry) =>
                entry.role !== FACTORY_FOREMAN_ROLE &&
                roleEnabled(entry.role, entry.file?.binding ?? {}).enabled,
            )
            .map((entry) => ({
              name: entry.role,
              description: entry.file?.binding.description ?? roleDefaults(entry.role).description,
            }))
        : null;
    return { ...found, body: file?.body ?? defaults.body, skills, delegates };
  });

  const roleOf: FactoryThreads["Service"]["roleOf"] = Effect.fn("FactoryThreads.roleOf")(
    function* (threadId) {
      const bound = yield* boundRole(threadId);
      if (bound === null) return null;
      return {
        factoryId: bound.factoryId,
        role: bound.role,
        body: bound.body,
        skills: bound.skills.map(({ name, description }) => ({ name, description })),
        ...(bound.delegates === null ? {} : { delegates: bound.delegates }),
      };
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
      const bound = yield* boundRole(threadId);
      if (bound === null) return [];
      return bound.skills.map((skill): BoundSkill =>
        skill.source === "builtin"
          ? { name: skill.name, source: skill.source, text: skill.text }
          : { name: skill.name, source: skill.source, directory: skill.directory },
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
