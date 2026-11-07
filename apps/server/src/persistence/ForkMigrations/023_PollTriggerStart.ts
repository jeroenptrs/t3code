import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // GitLab projects triggers raised every open merge request on their first poll before `start`.
  yield* sql`
    UPDATE scheduled_tasks
    SET schedule_json = json_set(schedule_json, '$.start', 'current')
    WHERE json_extract(schedule_json, '$.type') = 'gitlab_projects'
  `;
});
