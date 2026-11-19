import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const STAGES = ["new", "working", "waiting", "done", "failed", "dropped"];

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const isRole = (column: string) => sql`${sql(column)} NOT IN ${sql.in(STAGES)}`;

  // A stage no longer names the role that runs the item: each child thread carries its own role.
  // An item at a role's stage is working, and its history keeps the role it moved to in the note.
  yield* sql`
    UPDATE fork_factory_work_item_transitions
    SET note = 'Moved to ' || to_stage || '.' || COALESCE(' ' || note, '')
    WHERE ${isRole("to_stage")} AND to_stage <> from_stage
  `;
  yield* sql`
    UPDATE fork_factory_work_item_transitions SET to_stage = 'working' WHERE ${isRole("to_stage")}
  `;
  yield* sql`
    UPDATE fork_factory_work_item_transitions SET from_stage = 'working'
    WHERE ${isRole("from_stage")}
  `;
  yield* sql`UPDATE fork_factory_work_items SET stage = 'working' WHERE ${isRole("stage")}`;
  yield* sql`
    UPDATE fork_factory_work_items
    SET gate_json = json_set(gate_json, '$.resumeStage', 'working')
    WHERE json_extract(gate_json, '$.resumeStage') IS NOT NULL
      AND json_extract(gate_json, '$.resumeStage') <> 'done'
  `;
});
