import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A trigger's work item target as JSON. NULL when runs go to the thread the row describes.
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN fork_target_json TEXT`;
});
