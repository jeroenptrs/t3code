import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Reverse lookup from a Jira issue to the threads that link it, kept in step with each
  // thread's `jiraIssues` by the V2 projection. `branch-dismissed` tombstones are stored too.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_projection_thread_jira_issues (
      thread_id TEXT NOT NULL,
      site TEXT NOT NULL,
      issue_key TEXT NOT NULL,
      source TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      linked_by_user_id TEXT,
      snapshot_json TEXT,
      PRIMARY KEY (thread_id, site, issue_key)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_projection_thread_jira_issues_issue
    ON fork_projection_thread_jira_issues(site, issue_key)
  `;
});
