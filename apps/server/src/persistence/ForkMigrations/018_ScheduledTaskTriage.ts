import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A task's triage settings as JSON. NULL when the task has no triage.
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN triage_json TEXT`;
});
