import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import ScheduledAutomationSchema from "../../scheduledAutomation/ScheduledAutomationSchema.ts";

for (const legacyId of [36, 41]) {
  it.effect(
    `upgrades an automation database using legacy migration ${legacyId} without losing runs`,
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: legacyId - 1 });
        yield* ScheduledAutomationSchema;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${legacyId}, 'LocalScheduledAutomationsV1')`;
        yield* sql`INSERT INTO local_scheduled_automations_v1
        (id, revision, definition_json, enabled, enabled_at, last_scheduled_for,
         last_thread_id, last_outcome_json, created_at, updated_at)
        VALUES ('retained', 7, '{"prompt":"keep me"}', 1,
          '2026-08-01T00:00:00Z', '2026-08-12T00:00:00Z', 't3sa:v1:retained:thread',
          '{"status":"starting"}', '2026-08-01T00:00:00Z', '2026-08-12T00:00:00Z')`;
        const before = yield* sql`SELECT * FROM local_scheduled_automations_v1`;

        yield* runMigrations();
        yield* runMigrations();

        assert.deepEqual(yield* sql`SELECT * FROM local_scheduled_automations_v1`, before);
        const ledger = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = ${legacyId}`;
        assert.equal(
          ledger[0]?.name,
          legacyId === 36 ? "ProjectionThreadsPinned" : "AuthSessionClientConnection",
        );
        const threadColumns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(projection_threads)`;
        assert.includeMembers(
          threadColumns.map((row) => row.name),
          ["pinned_at", "active_order_key"],
        );
        const authColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
        assert.includeMembers(
          authColumns.map((row) => row.name),
          ["client_surface", "client_app_version"],
        );
        assert.deepEqual(
          yield* sql`SELECT migration_id, name FROM local_scheduled_automation_migrations`,
          [{ migration_id: 1, name: "LocalScheduledAutomationsV1" }],
        );
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
}

it.effect(
  "refuses to adopt a broken legacy automation table without changing migration history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`CREATE TABLE local_scheduled_automations_v1 (id TEXT PRIMARY KEY)`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (41, 'LocalScheduledAutomationsV1')`;
      const result = yield* Effect.exit(runMigrations());
      assert.equal(result._tag, "Failure");
      assert.deepEqual(yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 41`, [
        { name: "LocalScheduledAutomationsV1" },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
