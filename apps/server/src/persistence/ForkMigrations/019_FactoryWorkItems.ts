import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One piece of work a factory's Foreman routes. `source_json` and `gate_json` hold the contract
  // shapes; the stage changes only through a row in the transitions table below.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_factory_work_items (
      work_item_id TEXT PRIMARY KEY,
      factory_id TEXT NOT NULL,
      title TEXT NOT NULL,
      source_json TEXT NOT NULL,
      stage TEXT NOT NULL,
      gate_json TEXT NOT NULL,
      foreman_thread_id TEXT,
      foreman_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_factory_work_items_factory
    ON fork_factory_work_items(factory_id, created_at)
  `;
  // A delegated task's parent is looked up here on every delegation.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_factory_work_items_foreman
    ON fork_factory_work_items(foreman_thread_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_factory_work_item_threads (
      work_item_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      role TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (work_item_id, thread_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_factory_work_item_transitions (
      transition_id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      from_stage TEXT NOT NULL,
      to_stage TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      note TEXT,
      at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_factory_work_item_transitions_item
    ON fork_factory_work_item_transitions(work_item_id, at)
  `;
});
