import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const NOTE = "Dropped without a run: it was queued before each work item got its own run.";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Each item now gets its own Foreman thread. A queued item is stale work, so it is dropped
  // rather than started, which would launch a burst of runs on deploy.
  yield* sql`
    INSERT INTO fork_factory_work_item_transitions (
      transition_id, work_item_id, from_stage, to_stage, actor_json, note, at
    )
    SELECT 'work-item-transition:queued-dropped:' || work_item_id, work_item_id, 'new', 'dropped',
      '{"kind":"server"}', ${NOTE}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM fork_factory_work_items WHERE stage = 'queued'
  `;
  yield* sql`
    DELETE FROM fork_factory_work_item_transitions
    WHERE from_stage = 'queued' OR to_stage = 'queued'
  `;
  yield* sql`
    UPDATE fork_factory_work_items
    SET stage = 'dropped', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE stage = 'queued'
  `;
  // When a person dismissed a failed item, so it no longer counts for attention.
  yield* sql`ALTER TABLE fork_factory_work_items ADD COLUMN failure_dismissed_at TEXT`;
});
