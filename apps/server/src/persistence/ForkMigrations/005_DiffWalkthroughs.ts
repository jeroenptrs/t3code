import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One agent-written walkthrough per diff target, read and replaced whole.
  // The key leaves out the pull request's head, so a walkthrough for a new
  // head replaces the old one. thread_id is set for thread-diff targets only.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_diff_walkthroughs (
      target_key TEXT PRIMARY KEY,
      target_kind TEXT NOT NULL,
      thread_id TEXT,
      walkthrough_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
