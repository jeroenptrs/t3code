import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { DiffWalkthrough } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { forkMigrationManifest, forkMigrationsTable, runForkMigrations } from "./ForkMigrations.ts";
import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const decodeWalkthrough = Schema.decodeUnknownEffect(DiffWalkthrough);
const encodeWalkthrough = Schema.encodeEffect(DiffWalkthrough);

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

const assertDiffWalkthroughSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string; readonly pk: number }>`
    PRAGMA table_info(fork_diff_walkthroughs)
  `;
  assert.deepStrictEqual(
    columns.map(({ name, pk }) => [name, pk]),
    [
      ["target_key", 1],
      ["target_kind", 0],
      ["thread_id", 0],
      ["walkthrough_json", 0],
      ["updated_at", 0],
    ],
  );
});

it.effect("server startup records upstream and fork migrations in separate ledgers", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* readLedger("effect_sql_migrations"), migrationManifest);
    assert.deepStrictEqual(yield* readLedger(forkMigrationsTable), forkMigrationManifest);
    yield* assertEntraSchema;
    yield* assertScheduledTaskAuditSchema;
    yield* assertDiffWalkthroughSchema;
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
      [4, "WebhookDeliveryDispatchedAt"],
      [5, "DiffWalkthroughs"],
      [6, "DiffWalkthroughGuideShape"],
    ]);
    assert.deepStrictEqual(yield* readLedger("effect_sql_migrations"), migrationManifest);
    yield* assertEntraSchema;
    yield* assertScheduledTaskAuditSchema;
    yield* assertDiffWalkthroughSchema;
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

it.effect("rewrites stored walkthroughs into the guided review vocabulary", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* runForkMigrations({ toMigrationInclusive: 5 });
    const stored = {
      target: {
        kind: "thread-diff",
        threadId: "thread-1",
        fromTurnCount: 0,
        toTurnCount: 1,
      },
      groups: [
        {
          id: "storage",
          title: "Storage",
          summary: "Where walkthroughs live.",
          files: ["src/a.ts", "src/b.ts"],
        },
      ],
      notes: [
        {
          groupId: "storage",
          path: "src/a.ts",
          side: "additions",
          startLine: 3,
          endLine: 7,
          summary: "Adds the table.",
        },
        {
          groupId: "storage",
          path: "src/b.ts",
          side: "deletions",
          startLine: 1,
          endLine: 1,
          summary: "Drops the cache.",
          body: "It was never read.",
        },
      ],
      generatedAt: "2026-10-01T00:00:00.000Z",
      author: {},
    };
    yield* sql`
      INSERT INTO fork_diff_walkthroughs (
        target_key, target_kind, thread_id, walkthrough_json, updated_at
      ) VALUES (
        'thread-diff:thread-1:0-1', 'thread-diff', 'thread-1', ${JSON.stringify(stored)},
        '2026-10-01T00:00:00.000Z'
      )
    `;
    assert.deepStrictEqual(yield* runForkMigrations(), [[6, "DiffWalkthroughGuideShape"]]);
    const rows = yield* sql<{ readonly walkthroughJson: string }>`
      SELECT walkthrough_json AS "walkthroughJson" FROM fork_diff_walkthroughs
    `;
    const json: unknown = JSON.parse(rows[0]!.walkthroughJson);
    const walkthrough = yield* decodeWalkthrough(json);
    assert.deepStrictEqual(walkthrough.groups, [
      {
        id: "storage",
        title: "Storage",
        summary: "Where walkthroughs live.",
        attention: null,
        files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
        questions: [],
      },
    ]);
    assert.deepStrictEqual(walkthrough.notes, [
      {
        groupId: "storage",
        path: "src/a.ts",
        side: "new",
        start: 3,
        end: 7,
        summary: "Adds the table.",
      },
      {
        groupId: "storage",
        path: "src/b.ts",
        side: "old",
        start: 1,
        end: 1,
        summary: "Drops the cache.",
        body: "It was never read.",
      },
    ]);
    // The stored document is explicit, not reliant on decoding defaults.
    assert.deepStrictEqual(json, yield* encodeWalkthrough(walkthrough));
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
