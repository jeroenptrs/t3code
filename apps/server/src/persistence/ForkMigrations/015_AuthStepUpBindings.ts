import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A device that stepped up to a portal user, keyed by its DPoP proof key, so
  // the hourly T3 Connect token renewal mints a session bound to that user.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_auth_step_up_bindings (
      proof_key_thumbprint TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES auth_users(user_id),
      expires_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_auth_step_up_bindings_user
    ON fork_auth_step_up_bindings(user_id)
  `;
});
