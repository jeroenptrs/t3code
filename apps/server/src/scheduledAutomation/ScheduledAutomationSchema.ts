import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Intentionally omit IF NOT EXISTS. A pre-existing table in our durable
  // namespace must fail migration instead of being mistaken for this schema.
  yield* sql`
    CREATE TABLE local_scheduled_automations_v1 (
      id TEXT PRIMARY KEY NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
      revision INTEGER NOT NULL CHECK (revision > 0),
      definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      enabled_at TEXT,
      last_scheduled_for TEXT,
      last_thread_id TEXT,
      last_outcome_json TEXT CHECK (last_outcome_json IS NULL OR json_valid(last_outcome_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `;

  yield* sql`
    CREATE INDEX local_scheduled_automations_v1_enabled_cursor_idx
    ON local_scheduled_automations_v1 (enabled, last_scheduled_for)
  `;
  yield* sql`
    CREATE INDEX local_scheduled_automations_v1_enabled_at_idx
    ON local_scheduled_automations_v1 (enabled_at)
    WHERE enabled = 1
  `;
});
