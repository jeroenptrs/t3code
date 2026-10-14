import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A portal user's personal Jira token, one per user. The token and email live in the secret
  // store; this row is what clients may see. `created_at` changes on every replacement and is
  // the credential's version.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_jira_user_credentials (
      user_id TEXT PRIMARY KEY,
      site TEXT NOT NULL,
      cloud_id TEXT,
      account_id TEXT,
      account_display_name TEXT,
      account_avatar_url TEXT,
      created_at TEXT NOT NULL,
      last_verified_at TEXT,
      last_error TEXT
    )
  `;
});
