import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // An accepted delivery with no dispatched_at was answered 202 but never
  // dispatched, so startup dispatches it. Rows logged before this column
  // existed cannot say, and are treated as dispatched rather than re-run.
  yield* sql`
    ALTER TABLE scheduled_task_webhook_deliveries ADD COLUMN dispatched_at TEXT
  `;
  yield* sql`
    UPDATE scheduled_task_webhook_deliveries SET dispatched_at = received_at
  `;
});
