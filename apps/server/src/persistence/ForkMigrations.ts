/**
 * Fork-only migrations in their own ledger, numbered from 1 and run after upstream's, so a rebase
 * cannot make upstream skip one of its own ids. They may add fork tables, columns, and indexes but
 * never rename, drop, or rebuild an upstream table. Inventory: docs/internals/fork-migrations.md.
 */

import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { RunMigrationsOptions } from "./Migrations.ts";

import ForkMigration0001 from "./ForkMigrations/001_AuthUsers.ts";
import ForkMigration0002 from "./ForkMigrations/002_AuthSessionUsers.ts";
import ForkMigration0003 from "./ForkMigrations/003_ScheduledTaskUserAudit.ts";
import ForkMigration0004 from "./ForkMigrations/004_WebhookDeliveryDispatchedAt.ts";
import ForkMigration0005 from "./ForkMigrations/005_DiffWalkthroughs.ts";
import ForkMigration0006 from "./ForkMigrations/006_DiffWalkthroughGuideShape.ts";
import ForkMigration0007 from "./ForkMigrations/007_ProjectionThreadJiraIssues.ts";
import ForkMigration0008 from "./ForkMigrations/008_JiraUserCredentials.ts";
import ForkMigration0009 from "./ForkMigrations/009_JiraProposals.ts";
import ForkMigration0010 from "./ForkMigrations/010_ProjectionThreadJiraIssueWatch.ts";
import ForkMigration0011 from "./ForkMigrations/011_JiraRemoteLinks.ts";
import ForkMigration0012 from "./ForkMigrations/012_JiraBreakdowns.ts";
import ForkMigration0013 from "./ForkMigrations/013_Insights.ts";
import ForkMigration0014 from "./ForkMigrations/014_InsightsJiraIssues.ts";
import ForkMigration0015 from "./ForkMigrations/015_AuthStepUpBindings.ts";
import ForkMigration0016 from "./ForkMigrations/016_FactoryThreads.ts";
import ForkMigration0017 from "./ForkMigrations/017_TriggerObservations.ts";
import ForkMigration0018 from "./ForkMigrations/018_ScheduledTaskTriage.ts";
import ForkMigration0019 from "./ForkMigrations/019_FactoryWorkItems.ts";
import ForkMigration0017 from "./ForkMigrations/017_FactoryWorkItems.ts";
import ForkMigration0020 from "./ForkMigrations/020_FactoryWorkItemDispatch.ts";

export const forkMigrationsTable = "fork_sql_migrations";

export const forkMigrationEntries = [
  [1, "AuthUsers", ForkMigration0001],
  [2, "AuthSessionUsers", ForkMigration0002],
  [3, "ScheduledTaskUserAudit", ForkMigration0003],
  [4, "WebhookDeliveryDispatchedAt", ForkMigration0004],
  [5, "DiffWalkthroughs", ForkMigration0005],
  [6, "DiffWalkthroughGuideShape", ForkMigration0006],
  [7, "ProjectionThreadJiraIssues", ForkMigration0007],
  [8, "JiraUserCredentials", ForkMigration0008],
  [9, "JiraProposals", ForkMigration0009],
  [10, "ProjectionThreadJiraIssueWatch", ForkMigration0010],
  [11, "JiraRemoteLinks", ForkMigration0011],
  [12, "JiraBreakdowns", ForkMigration0012],
  [13, "Insights", ForkMigration0013],
  [14, "InsightsJiraIssues", ForkMigration0014],
  [15, "AuthStepUpBindings", ForkMigration0015],
  [16, "FactoryThreads", ForkMigration0016],
  [17, "TriggerObservations", ForkMigration0017],
  [18, "ScheduledTaskTriage", ForkMigration0018],
  [19, "FactoryWorkItems", ForkMigration0019],
  [17, "FactoryWorkItems", ForkMigration0017],
  [20, "FactoryWorkItemDispatch", ForkMigration0020],
] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

const run = Migrator.make({});

/**
 * Run pending fork migrations. Call after `runMigrations()` has completed. Tests stop at
 * `toMigrationInclusive` to seed rows in an older shape.
 */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  const executedMigrations = yield* run({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        forkMigrationEntries
          .filter(([id]) => toMigrationInclusive === undefined || id <= toMigrationInclusive)
          .map(([id, name, migration]) => [`${id}_${name}`, migration]),
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

/** True when this build has fork migrations the database has not recorded. */
export const hasPendingForkMigrations = Effect.fn("hasPendingForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${forkMigrationsTable}
  `;
  if (tables.length === 0) return true;
  const rows = yield* sql<{ readonly latestId: number | null }>`
    SELECT MAX(migration_id) AS latestId FROM ${sql(forkMigrationsTable)}
  `;
  const latestForkId = Math.max(...forkMigrationEntries.map(([id]) => id));
  return (rows[0]?.latestId ?? 0) < latestForkId;
});
