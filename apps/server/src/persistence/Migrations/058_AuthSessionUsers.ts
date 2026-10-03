import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Sessions issued by Entra sign-in belong to a portal user and take their
  // access from that user's current record. Service sessions leave it NULL.
  yield* sql`
    ALTER TABLE auth_sessions ADD COLUMN user_id TEXT REFERENCES auth_users(user_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
    ON auth_sessions(user_id)
    WHERE user_id IS NOT NULL
  `;
});
