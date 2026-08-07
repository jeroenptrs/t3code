import {
  ScheduledAutomation,
  ScheduledAutomationDefinition,
  ScheduledAutomationId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { makeScheduledAutomationRepository } from "../../scheduledAutomation/ScheduledAutomationRepository.ts";

const decodeScheduledAutomationDefinition = Schema.decodeUnknownEffect(
  ScheduledAutomationDefinition,
);
const decodeScheduledAutomation = Schema.decodeUnknownEffect(ScheduledAutomation);

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_LocalScheduledAutomationsV1", (it) => {
  it.effect("creates only the namespaced v1 table with constraints and indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 35 });
      yield* sql`DROP TABLE IF EXISTS local_scheduled_automations_v1`;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 36`;
      yield* runMigrations({ toMigrationInclusive: 36 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
      `;
      const names = tables.map((row) => row.name);
      assert.include(names, "local_scheduled_automations_v1");
      assert.notInclude(names, "automations");
      assert.isFalse(names.some((name) => /scheduled.*(?:run|job|history)/i.test(name)));

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly pk: number;
      }>`PRAGMA table_info(local_scheduled_automations_v1)`;
      assert.deepStrictEqual(
        columns.map(({ name }) => name),
        [
          "id",
          "schema_version",
          "revision",
          "definition_json",
          "enabled",
          "enabled_at",
          "last_scheduled_for",
          "last_thread_id",
          "last_outcome_json",
          "created_at",
          "updated_at",
        ],
      );
      assert.equal(columns.find((column) => column.name === "id")?.pk, 1);
      assert.equal(columns.find((column) => column.name === "schema_version")?.notnull, 1);

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'local_scheduled_automations_v1'
      `;
      assert.include(
        indexes.map((row) => row.name),
        "local_scheduled_automations_v1_enabled_cursor_idx",
      );
      assert.include(
        indexes.map((row) => row.name),
        "local_scheduled_automations_v1_enabled_at_idx",
      );

      const definition = yield* decodeScheduledAutomationDefinition({
        name: "Migration fixture",
        prompt: "Exercise every durable field.",
        projectId: "project-1",
        modelSelection: { instanceId: "codex-work", model: "gpt-5.6" },
        runtimeMode: "full-access",
        interactionMode: "default",
        worktreePolicy: { kind: "current" },
        setupScriptPolicy: "skip",
        schedule: { cron: "0 9 * * 1", timeZone: "UTC", misfirePolicy: "latest-only" },
      });
      const repository = yield* makeScheduledAutomationRepository;
      const id = ScheduledAutomationId.make("migration-fixture");
      yield* repository.create({
        id,
        definition,
        createdAt: "2026-08-03T09:00:00.000Z",
      });
      const populated = yield* repository.compareAndSwapUpdate({
        automationId: id,
        expectedRevision: 1,
        replacement: {
          ...definition,
          enabled: true,
          enabledAt: "2026-08-03T09:01:00.000Z",
          lastScheduledFor: "2026-08-04T09:00:00.000Z",
          lastThreadId: ThreadId.make("t3sa:v1:migration:thread"),
          lastOutcome: {
            kind: "failed",
            scheduledFor: "2026-08-04T09:00:00.000Z",
            observedAt: "2026-08-04T09:00:01.000Z",
            coalescedCount: 3,
            code: "fixture.failure",
            detail: "Migration fixture failure.",
            retryable: true,
          },
          updatedAt: "2026-08-04T09:00:01.000Z",
        },
      });
      assert.deepStrictEqual(yield* decodeScheduledAutomation(populated), populated);
    }),
  );

  it.effect("leaves an unrelated automations table unchanged", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 35 });
      yield* sql`DROP TABLE IF EXISTS local_scheduled_automations_v1`;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 36`;
      yield* sql`CREATE TABLE automations (opaque BLOB PRIMARY KEY, meaning INTEGER NOT NULL)`;
      yield* sql`INSERT INTO automations (opaque, meaning) VALUES (X'00FF10', 73)`;
      const beforeSchema = yield* sql<{ readonly sql: string }>`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'automations'
      `;
      const beforeRows = yield* sql<{ readonly opaque: string; readonly meaning: number }>`
        SELECT hex(opaque) AS opaque, meaning FROM automations
      `;

      yield* runMigrations({ toMigrationInclusive: 36 });

      const afterSchema = yield* sql<{ readonly sql: string }>`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'automations'
      `;
      const afterRows = yield* sql<{ readonly opaque: string; readonly meaning: number }>`
        SELECT hex(opaque) AS opaque, meaning FROM automations
      `;
      assert.deepStrictEqual(afterSchema, beforeSchema);
      assert.deepStrictEqual(afterRows, beforeRows);
      const local = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'local_scheduled_automations_v1'
      `;
      assert.lengthOf(local, 1);
    }),
  );

  it.effect("fails loudly for a pre-existing incompatible namespaced table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 35 });
      yield* sql`DROP TABLE IF EXISTS local_scheduled_automations_v1`;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 36`;
      yield* sql`CREATE TABLE local_scheduled_automations_v1 (id TEXT PRIMARY KEY)`;

      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 36 }));
      assert.equal(exit._tag, "Failure");
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(local_scheduled_automations_v1)
      `;
      assert.deepStrictEqual(
        columns.map((column) => column.name),
        ["id"],
      );
    }),
  );
});
