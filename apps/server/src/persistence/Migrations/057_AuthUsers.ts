import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Human portal users, keyed by their Entra identity. Service identities
  // (pairing clients, Slack) stay in auth_sessions and never appear here.
  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_users (
      user_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      object_id TEXT NOT NULL,
      status TEXT NOT NULL,
      role TEXT,
      email TEXT,
      display_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_sign_in_at TEXT,
      UNIQUE (tenant_id, object_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_user_access_changes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES auth_users(user_id),
      actor_type TEXT NOT NULL,
      actor_user_id TEXT,
      previous_status TEXT,
      status TEXT NOT NULL,
      previous_role TEXT,
      role TEXT,
      changed_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_user_access_changes_user
    ON auth_user_access_changes(user_id, sequence)
  `;
});
