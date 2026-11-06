import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Items that waited behind the factory's active item sat at `new` with no dispatch time.
  yield* sql`
    UPDATE fork_factory_work_items SET stage = 'queued'
    WHERE stage = 'new' AND dispatched_at IS NULL
  `;
});
