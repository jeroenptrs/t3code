// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceReadAccess - where a session may read on the host.
 *
 * A session that can operate already runs agents with the host's access, so it
 * reads anywhere, including files outside every project. A read-only session
 * (the portal's Reader role) sees files inside the roots of active projects and
 * their threads' worktrees, and nothing else. Paths are compared after
 * resolving symlinks, so `..` segments and links that point out of a root are
 * refused. The state directory is never readable, and a root that contains it,
 * such as a project rooted at the home directory, is too broad to count: that
 * project's conversations stay visible, its files do not.
 *
 * @module WorkspaceReadAccess
 */
import * as NodeFSP from "node:fs/promises";

import { AuthOrchestrationOperateScope, type AuthEnvironmentScope } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";

export class WorkspaceReadDeniedError extends Schema.TaggedError<WorkspaceReadDeniedError>()(
  "WorkspaceReadDeniedError",
  {
    path: Schema.String,
  },
) {
  override get message(): string {
    return `Read-only access is limited to project folders: ${this.path}`;
  }
}

export class WorkspaceReadAccess extends Context.Service<
  WorkspaceReadAccess,
  {
    /**
     * Fails unless a session holding `scopes` may read `targetPath`: any path when
     * it can operate, otherwise one that exists inside a readable root.
     */
    readonly ensureReadable: (
      scopes: ReadonlyArray<AuthEnvironmentScope>,
      targetPath: string,
    ) => Effect.Effect<void, WorkspaceReadDeniedError>;
  }
>()("t3/workspace/WorkspaceReadAccess") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;

  const realpath = (target: string) =>
    Effect.promise(() => NodeFSP.realpath(target).catch(() => null));
  const contains = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return !(
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    );
  };

  // Fails closed: a store error leaves no roots, so the read is refused.
  const knownRoots = sql<{ readonly root: string }>`
    SELECT workspace_root AS root FROM projection_projects WHERE deleted_at IS NULL
    UNION
    SELECT json_extract(t.payload_json, '$.worktreePath') AS root
    FROM orchestration_v2_projection_threads t
    JOIN projection_projects p ON p.project_id = t.project_id
    WHERE t.deleted_at IS NULL
      AND p.deleted_at IS NULL
      AND json_extract(t.payload_json, '$.worktreePath') IS NOT NULL
  `.pipe(
    Effect.tapError((cause) => Effect.logWarning("Failed to list readable workspace roots", cause)),
    Effect.orElseSucceed(() => []),
  );

  const ensureReadable: WorkspaceReadAccess["Service"]["ensureReadable"] = Effect.fn(
    "WorkspaceReadAccess.ensureReadable",
  )(function* (scopes, targetPath) {
    if (scopes.includes(AuthOrchestrationOperateScope)) return;
    const denied = new WorkspaceReadDeniedError({ path: targetPath });
    const realTarget = yield* realpath(targetPath);
    if (realTarget === null) return yield* denied;
    const stateDir = (yield* realpath(config.stateDir)) ?? path.resolve(config.stateDir);
    if (contains(stateDir, realTarget)) return yield* denied;
    for (const { root } of yield* knownRoots) {
      const realRoot = yield* realpath(root);
      if (realRoot !== null && !contains(realRoot, stateDir) && contains(realRoot, realTarget)) {
        return;
      }
    }
    return yield* denied;
  });

  return WorkspaceReadAccess.of({ ensureReadable });
});

export const layer = Layer.effect(WorkspaceReadAccess, make);
