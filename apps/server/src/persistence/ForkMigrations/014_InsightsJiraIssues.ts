import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Insights: the Jira issue behind each key stored commits and merge requests carry, read as the
  // service identity. A key Jira did not return gets a row with a null issue type, so it is asked
  // again only when the row is refreshed.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_insights_jira_issues (
      site TEXT NOT NULL,
      key TEXT NOT NULL,
      issue_type TEXT,
      status_category TEXT,
      parent_key TEXT,
      summary TEXT,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (site, key)
    )
  `;
});
