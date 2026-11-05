import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The last state a trigger source saw per key (a Jira issue, a GitLab merge request), so a
  // change that lands while the server is down still raises its event on the next read.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_trigger_observations (
      source TEXT NOT NULL,
      key TEXT NOT NULL,
      state_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (source, key)
    )
  `;
});
