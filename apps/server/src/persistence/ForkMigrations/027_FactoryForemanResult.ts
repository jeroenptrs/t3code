import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The Foreman's typed result, and the run it came from, so a replayed submission applies once.
  yield* sql`ALTER TABLE fork_factory_work_items ADD COLUMN foreman_result_json TEXT`;
  yield* sql`ALTER TABLE fork_factory_work_items ADD COLUMN foreman_result_run_id TEXT`;
});
