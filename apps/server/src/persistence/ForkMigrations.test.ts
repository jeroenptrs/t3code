import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { forkMigrationManifest, forkMigrationsTable, runForkMigrations } from "./ForkMigrations.ts";
import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const memoryDatabase = () => NodeSqliteClient.layer({ filename: ":memory:" });

const readLedger = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id
    `;
    return rows.map(({ migration_id, name }) => [migration_id, name] as const);
  });

const assertEntraSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('auth_users', 'auth_user_access_changes')
    ORDER BY name
  `;
  assert.deepStrictEqual(
    tables.map(({ name }) => name),
    ["auth_user_access_changes", "auth_users"],
  );
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
  assert.ok(columns.some(({ name }) => name === "user_id"));
});

const assertScheduledTaskAuditSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  const names = new Set(columns.map(({ name }) => name));
  for (const column of [
    "created_by_user_id",
    "webhook_token_rotated_by_user_id",
    "webhook_token_rotated_at",
  ]) {
    assert.ok(names.has(column), column);
  }
});

it.effect("server startup records upstream and fork migrations in separate ledgers", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* readLedger("effect_sql_migrations"), migrationManifest);
    assert.deepStrictEqual(yield* readLedger(forkMigrationsTable), forkMigrationManifest);
    yield* assertEntraSchema;
    yield* assertScheduledTaskAuditSchema;
    assert.deepStrictEqual(yield* runForkMigrations(), []);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("adds fork migrations to a database already at upstream's latest", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    assert.deepStrictEqual(yield* runForkMigrations(), [
      [1, "AuthUsers"],
      [2, "AuthSessionUsers"],
      [3, "ScheduledTaskUserAudit"],
    ]);
    assert.deepStrictEqual(yield* readLedger("effect_sql_migrations"), migrationManifest);
    yield* assertEntraSchema;
    yield* assertScheduledTaskAuditSchema;
  }).pipe(Effect.provide(memoryDatabase())),
);

it.effect("leaves scheduled tasks created before the audit columns without a user", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* sql`
      INSERT INTO scheduled_tasks (
        task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
        workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
        created_by, creation_source, created_at, updated_at, next_run_at, last_run_at,
        last_run_status, last_run_error, run_count, webhook_token, webhook_secret
      ) VALUES (
        'scheduled-task:old', 'Old hook', 'Prompt', 1, '{"type":"webhook","signature":null}',
        'project-1', NULL, '{"type":"root"}', '{"instanceId":"codex","model":"gpt-5.4"}',
        'full-access', 'default', 'user', 'web', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', NULL, NULL, 'never', NULL, 0, 'token', NULL
      )
    `;
    yield* runForkMigrations();
    const rows = yield* sql<{
      readonly created_by_user_id: string | null;
      readonly webhook_token_rotated_by_user_id: string | null;
      readonly webhook_token_rotated_at: string | null;
    }>`
      SELECT created_by_user_id, webhook_token_rotated_by_user_id, webhook_token_rotated_at
      FROM scheduled_tasks WHERE task_id = 'scheduled-task:old'
    `;
    assert.deepStrictEqual(rows, [
      {
        created_by_user_id: null,
        webhook_token_rotated_by_user_id: null,
        webhook_token_rotated_at: null,
      },
    ]);
  }).pipe(Effect.provide(memoryDatabase())),
);

it.effect("still runs upstream's next migration after fork migrations were applied", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* runForkMigrations();

    const nextId = migrationEntries.length + 1;
    const nextUpstream = Migrator.fromRecord({
      ...Object.fromEntries(
        migrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
      [`${nextId}_HypotheticalUpstream`]: sql`CREATE TABLE hypothetical_upstream (id TEXT)`,
    });
    assert.deepStrictEqual(yield* Migrator.make({})({ loader: nextUpstream }), [
      [nextId, "HypotheticalUpstream"],
    ]);
    const tables = yield* sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hypothetical_upstream'
    `;
    assert.equal(tables.length, 1);
    assert.deepStrictEqual(yield* runForkMigrations(), []);
  }).pipe(Effect.provide(memoryDatabase())),
);
