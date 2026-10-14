import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The apply ledger for Jira proposals: what an approval wrote so far, who approved it, and
  // the claim that keeps two approvals from writing at once. The proposal's turn item is what
  // clients see; this row is what makes a retried approval write only what is missing.
  // `proposal_id` is the turn item id, which is the request's idempotency key.
  // `proposal_json` is the proposal as last approved; `progress_json` the issues written and
  // the steps done so far; `claim_id` names the approval holding the row.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_jira_proposals (
      proposal_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      site TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_by_provider_instance_id TEXT NOT NULL,
      requested_model TEXT,
      approved_by_user_id TEXT,
      approved_at TEXT,
      proposal_json TEXT NOT NULL,
      progress_json TEXT,
      error TEXT,
      claim_id TEXT,
      claimed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Thread shells show a waiting proposal as pending input whatever its run's state; this keeps
  // that lookup off the thread's turn item history.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_turn_items_waiting_jira_proposals
    ON orchestration_v2_projection_turn_items(thread_id, updated_at)
    WHERE type = 'jira_proposal' AND status = 'waiting'
  `;
});
