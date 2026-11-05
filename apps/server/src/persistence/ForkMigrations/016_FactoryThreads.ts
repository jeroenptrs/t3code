import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Threads a factory started for one of its roles. A thread belongs to at most one factory.
  // `factory_id` is `factory:<projectId>:<name>`; the definition itself lives in files.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_factory_threads (
      factory_id TEXT NOT NULL,
      thread_id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_factory_threads_factory
    ON fork_factory_threads(factory_id)
  `;

  // A factory also owns the threads its scheduled tasks sent work into, found by the task id on
  // their messages. Partial, so it holds only scheduled messages.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_messages_scheduled_task
    ON orchestration_v2_projection_messages(json_extract(payload_json, '$.scheduledTaskId'))
    WHERE json_extract(payload_json, '$.scheduledTaskId') IS NOT NULL
  `;
});
