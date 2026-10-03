import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthUserRoleScopes } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as WorkspaceReadAccess from "./WorkspaceReadAccess.ts";

const TestLayer = WorkspaceReadAccess.layer.pipe(
  Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-read-access-test-" })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const encodeThreadPayload = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ worktreePath: Schema.String })),
);
const reader = AuthUserRoleScopes.reader;
const operator = AuthUserRoleScopes.operator;
const now = "2026-10-03T00:00:00.000Z";

/**
 * A project at `<tmp>/app` with a thread worktree at `<tmp>/worktrees/feature`,
 * a file outside both at `<tmp>/outside/secret.txt`, and a secret in the state dir.
 */
const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const tmp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-read-access-" });
  const write = (file: string) =>
    fileSystem
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.andThen(fileSystem.writeFileString(file, "contents")), Effect.orDie);

  const app = path.join(tmp, "app");
  const worktree = path.join(tmp, "worktrees", "feature");
  const outside = path.join(tmp, "outside", "secret.txt");
  const stateSecret = path.join(config.stateDir, "secrets", "token");
  yield* write(path.join(app, "src", "index.ts"));
  yield* write(path.join(worktree, "notes.md"));
  yield* write(outside);
  yield* write(stateSecret);

  const insertProject = (projectId: string, workspaceRoot: string) => sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, auto_pull, scripts_json, created_at, updated_at
    )
    VALUES (${projectId}, ${projectId}, ${workspaceRoot}, ${0}, ${"[]"}, ${now}, ${now})
  `;
  // Tests share one database, so ids come from this test's temp dir.
  const projectId = `project-${path.basename(tmp)}`;
  yield* insertProject(projectId, app);
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json
    )
    VALUES (
      ${`thread-${path.basename(tmp)}`}, ${projectId}, ${"Feature"}, ${"codex"}, ${"full-access"},
      ${"default"}, ${now}, ${now}, ${encodeThreadPayload({ worktreePath: worktree })}
    )
  `;
  return { app, worktree, outside, stateSecret, tmp, insertProject };
});

const deniedTag = (effect: Effect.Effect<void, WorkspaceReadAccess.WorkspaceReadDeniedError>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error._tag));

it.layer(TestLayer)("WorkspaceReadAccess", (it) => {
  describe("a read-only session", () => {
    it.effect("reads inside a project root and inside a thread worktree", () =>
      Effect.gen(function* () {
        const access = yield* WorkspaceReadAccess.WorkspaceReadAccess;
        const path = yield* Path.Path;
        const { app, worktree } = yield* setup;

        yield* access.ensureReadable(reader, app);
        yield* access.ensureReadable(reader, path.join(app, "src", "index.ts"));
        yield* access.ensureReadable(reader, path.join(worktree, "notes.md"));
      }),
    );

    it.effect("is refused a path outside every root, a .. escape, and the state dir", () =>
      Effect.gen(function* () {
        const access = yield* WorkspaceReadAccess.WorkspaceReadAccess;
        const { app, outside, stateSecret } = yield* setup;

        for (const target of [outside, `${app}/../outside/secret.txt`, stateSecret]) {
          assert.equal(
            yield* deniedTag(access.ensureReadable(reader, target)),
            "WorkspaceReadDeniedError",
            target,
          );
        }
      }),
    );

    it.effect.skipIf(!symlinksSupported)("is refused a symlink that leaves the root", () =>
      Effect.gen(function* () {
        const access = yield* WorkspaceReadAccess.WorkspaceReadAccess;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { app, outside } = yield* setup;
        const link = path.join(app, "linked-secret.txt");
        yield* fileSystem.symlink(outside, link);

        assert.equal(
          yield* deniedTag(access.ensureReadable(reader, link)),
          "WorkspaceReadDeniedError",
        );
      }),
    );

    it.effect("gets nothing from a project whose root contains the state dir", () =>
      Effect.gen(function* () {
        const access = yield* WorkspaceReadAccess.WorkspaceReadAccess;
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { insertProject, stateSecret } = yield* setup;
        const notes = path.join(config.baseDir, "notes.txt");
        yield* fileSystem.writeFileString(notes, "contents");
        yield* insertProject("project-base-dir", config.baseDir);

        for (const target of [notes, stateSecret]) {
          assert.equal(
            yield* deniedTag(access.ensureReadable(reader, target)),
            "WorkspaceReadDeniedError",
            target,
          );
        }
      }),
    );
  });

  it.effect("lets a session with operate scopes read anywhere, as before", () =>
    Effect.gen(function* () {
      const access = yield* WorkspaceReadAccess.WorkspaceReadAccess;
      const { outside, stateSecret, tmp } = yield* setup;

      yield* access.ensureReadable(operator, outside);
      yield* access.ensureReadable(operator, stateSecret);
      yield* access.ensureReadable(operator, `${tmp}/does-not-exist`);
    }),
  );
});
