import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The link's watch, mirrored from the thread payload so the Jira sweep finds watched issues
  // without decoding every thread. No link had a watch before this column existed.
  yield* sql`ALTER TABLE fork_projection_thread_jira_issues ADD COLUMN watch_json TEXT`;
});
