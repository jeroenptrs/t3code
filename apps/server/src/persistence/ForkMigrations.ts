/**
 * Fork-only migrations, kept out of upstream's list and ledger.
 *
 * The migrator skips every id at or below the highest one recorded, so a fork
 * migration numbered inside upstream's sequence would make upstream's own
 * migration at that id silently never run after a rebase. Fork migrations
 * instead number from 1 in their own ledger table and run after upstream's
 * migrations have completed. Every caller of `runMigrations()` that opens a
 * real database must also call `runForkMigrations()` right after it.
 *
 * Because they run after upstream, fork migrations may create fork-owned
 * tables and add columns or indexes to upstream tables. They must not rename,
 * drop, or rebuild upstream tables or change upstream columns: a later upstream
 * migration assumes upstream's schema and would conflict with or undo it.
 * Columns added to upstream tables are lost if upstream later recreates the
 * table, and the fork ledger would not notice. When rebasing, check new
 * upstream migrations for rebuilds of tables listed below and add a fork
 * migration that restores the fork columns.
 *
 * Fork columns on upstream tables: `auth_sessions.user_id` (002);
 * `scheduled_tasks.created_by_user_id`, `webhook_token_rotated_by_user_id`,
 * `webhook_token_rotated_at` (003).
 */

import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import ForkMigration0001 from "./ForkMigrations/001_AuthUsers.ts";
import ForkMigration0002 from "./ForkMigrations/002_AuthSessionUsers.ts";
import ForkMigration0003 from "./ForkMigrations/003_ScheduledTaskUserAudit.ts";

export const forkMigrationsTable = "fork_sql_migrations";

export const forkMigrationEntries = [
  [1, "AuthUsers", ForkMigration0001],
  [2, "AuthSessionUsers", ForkMigration0002],
  [3, "ScheduledTaskUserAudit", ForkMigration0003],
] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

const run = Migrator.make({});

/** Run pending fork migrations. Call after `runMigrations()` has completed. */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const executedMigrations = yield* run({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
    table: forkMigrationsTable,
  });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Fork database schema is current")
    : Effect.log("Fork migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));

  // Same id-only skipping as upstream's ledger: two fork branches that claimed
  // the same id leave one of them unapplied.
  const sql = yield* SqlClient.SqlClient;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM ${sql(forkMigrationsTable)}`;
  const manifestNames = new Map<number, string>(forkMigrationManifest);
  const divergent = recorded.flatMap((row) => {
    const expected = manifestNames.get(row.migration_id);
    if (expected === undefined) {
      return [`${row.migration_id}:${row.name} (unknown to this build)`];
    }
    return expected === row.name
      ? []
      : [`${row.migration_id}:${row.name} (this build: ${expected})`];
  });
  if (divergent.length > 0) {
    yield* Effect.logWarning(
      "Fork migration history diverges from this build; recorded migration ids are skipped, not reconciled by name.",
    ).pipe(Effect.annotateLogs({ divergent }));
  }
  return executedMigrations;
});
