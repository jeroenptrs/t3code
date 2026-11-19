import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const NOTE = "Dropped without a run: it was queued before each work item got its own run.";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // 024 first shipped moving queued items back to `new` for the service to start. An item created
  // before 024 ran that never started is that stale work, so it is dropped, not dispatched.
  const stale = sql`
    SELECT w.work_item_id FROM fork_factory_work_items w
    WHERE w.stage = 'new' AND w.dispatched_at IS NULL
      AND datetime(w.created_at) < (
        SELECT datetime(created_at) FROM fork_sql_migrations WHERE migration_id = 24
      )
  `;
  yield* sql`
    INSERT INTO fork_factory_work_item_transitions (
      transition_id, work_item_id, from_stage, to_stage, actor_json, note, at
    )
    SELECT 'work-item-transition:queued-dropped:' || work_item_id, work_item_id, 'new', 'dropped',
      '{"kind":"server"}', ${NOTE}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM fork_factory_work_items WHERE work_item_id IN (${stale})
  `;
  yield* sql`
    UPDATE fork_factory_work_items
    SET stage = 'dropped', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE work_item_id IN (${stale})
  `;
});
