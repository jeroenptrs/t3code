import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Each item now gets its own Foreman thread, so nothing waits behind another item. Queued items
  // go back to `new` with no dispatch time, which the service dispatches when it starts.
  yield* sql`UPDATE fork_factory_work_items SET stage = 'new' WHERE stage = 'queued'`;
  yield* sql`
    DELETE FROM fork_factory_work_item_transitions
    WHERE from_stage = 'queued' OR to_stage = 'queued'
  `;
  // When a person dismissed a failed item, so it no longer counts for attention.
  yield* sql`ALTER TABLE fork_factory_work_items ADD COLUMN failure_dismissed_at TEXT`;
});
