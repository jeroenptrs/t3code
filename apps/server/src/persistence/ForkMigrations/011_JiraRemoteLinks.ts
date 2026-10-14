import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The Jira remote links the server wrote for threads, so a link whose thread was unlinked,
  // archived or deleted while the server was down, or whose delete failed, is still removed
  // after a restart. A row goes only once Jira confirms the link is gone. `global_id` is the
  // id Jira knows the link by; `title` is what was last written, so an unchanged link is not
  // written again.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_jira_remote_links (
      site TEXT NOT NULL,
      issue_key TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      global_id TEXT NOT NULL,
      title TEXT NOT NULL,
      written_at TEXT NOT NULL,
      PRIMARY KEY (site, issue_key, thread_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_jira_remote_links_thread
    ON fork_jira_remote_links(thread_id)
  `;
});
