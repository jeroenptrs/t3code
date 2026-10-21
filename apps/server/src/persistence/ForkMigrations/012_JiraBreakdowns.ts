import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Threads the server started to break a Jira issue into work packages. A row marks the thread
  // as a breakdown, which grants its agent the breakdown instructions, and lets a second press
  // join a breakdown still running, across restarts too. `status` is `running` until the
  // thread's first run ends, then `proposed`, `no-proposal` or `failed`, with `reason` saying
  // why for the last two.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_jira_breakdowns (
      thread_id TEXT PRIMARY KEY,
      site TEXT NOT NULL,
      issue_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_jira_breakdowns_issue
    ON fork_jira_breakdowns(site, issue_key, status)
  `;
});
