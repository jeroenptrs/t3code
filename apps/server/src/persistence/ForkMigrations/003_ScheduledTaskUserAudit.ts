import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Which portal user created a scheduled task and last rotated its webhook
  // token. NULL when the session had no user (agents, pairing and service
  // sessions, or Entra off). No foreign key: an audit label must not block
  // removing a user, and readers fall back when the user is gone.
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN created_by_user_id TEXT`;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN webhook_token_rotated_by_user_id TEXT`;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN webhook_token_rotated_at TEXT`;
});
