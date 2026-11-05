import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // When the server sent the item to its Foreman; null while it waits behind the factory's
  // active item. Items from before this column were sent as they were created.
  yield* sql`
    ALTER TABLE fork_factory_work_items ADD COLUMN dispatched_at TEXT
  `;
  yield* sql`
    UPDATE fork_factory_work_items SET dispatched_at = created_at
    WHERE foreman_run_id IS NOT NULL
  `;
});
