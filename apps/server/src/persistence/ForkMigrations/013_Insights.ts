import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Insights: estimated coding output per contributor, from GitLab merge requests and local git.
  // Server-owned state, not thread state, so plain tables the Insights service reads and writes.
  // Times are ISO strings in UTC.

  // Global settings as JSON values: start_date, release_branch_patterns, request_budget_per_tick.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_insights_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_by_user_id TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  // One row per T3 project an administrator has touched; a project without a row is disabled.
  // A null cursor means the next walk starts from the start date and refetches everything.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_insights_projects (
      project_id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      default_branch TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      enabled_at TEXT,
      enabled_by_user_id TEXT,
      mr_cursor TEXT,
      default_branch_cursor TEXT,
      last_sync_at TEXT,
      last_error TEXT
    )
  `;

  // Nothing beyond this row is stored for a contributor until an administrator includes them.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_insights_contributors (
      contributor_id TEXT PRIMARY KEY,
      display_name TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'included', 'excluded')),
      kind TEXT NOT NULL DEFAULT 'human' CHECK (kind IN ('human', 'agent', 'bot')),
      user_id TEXT,
      gitlab_login TEXT COLLATE NOCASE UNIQUE,
      jira_account_id TEXT,
      first_seen_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by_user_id TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_insights_contributor_emails (
      email TEXT PRIMARY KEY COLLATE NOCASE,
      contributor_id TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_insights_contributor_emails_contributor
    ON fork_insights_contributor_emails(contributor_id)
  `;

  // Merge requests by included authors. The body is never stored.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_insights_merge_requests (
      project_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      author_contributor_id TEXT,
      author_login TEXT,
      state TEXT NOT NULL,
      is_draft INTEGER NOT NULL,
      title TEXT NOT NULL,
      head_branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      labels_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      merged_at TEXT,
      closed_at TEXT,
      updated_at TEXT NOT NULL,
      head_sha TEXT,
      first_review_at TEXT,
      first_commit_authored_at TEXT,
      changed_files INTEGER,
      commits_truncated INTEGER NOT NULL DEFAULT 0,
      notes_truncated INTEGER NOT NULL DEFAULT 0,
      jira_keys_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (project_id, number)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_insights_merge_requests_author
    ON fork_insights_merge_requests(author_contributor_id, merged_at)
  `;

  // Reviews given by included contributors, earliest per kind.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_insights_mr_reviews (
      project_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      reviewer_contributor_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('comment', 'thread', 'approval')),
      first_at TEXT NOT NULL,
      PRIMARY KEY (project_id, number, reviewer_contributor_id, kind)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_insights_mr_reviews_reviewer
    ON fork_insights_mr_reviews(reviewer_contributor_id, first_at)
  `;

  // Commits by included contributors. `superseded_by_sha` is set when a rebase replaced the
  // commit; superseded commits count for nothing.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_insights_commits (
      project_id TEXT NOT NULL,
      sha TEXT NOT NULL,
      contributor_id TEXT NOT NULL,
      author_email TEXT NOT NULL,
      authored_at TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      mr_number INTEGER,
      patch_id TEXT,
      superseded_by_sha TEXT,
      additions INTEGER NOT NULL,
      deletions INTEGER NOT NULL,
      files_changed INTEGER NOT NULL,
      file_mix REAL NOT NULL,
      estimated_hours REAL NOT NULL,
      estimate_method TEXT NOT NULL DEFAULT 'tier1',
      landed_at TEXT,
      landed_branch TEXT,
      has_agent_coauthor INTEGER NOT NULL DEFAULT 0,
      jira_keys_json TEXT NOT NULL DEFAULT '[]',
      message_subject TEXT NOT NULL,
      PRIMARY KEY (project_id, sha)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_insights_commits_authored
    ON fork_insights_commits(contributor_id, authored_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_insights_commits_landed
    ON fork_insights_commits(contributor_id, landed_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_insights_commits_patch_id
    ON fork_insights_commits(project_id, patch_id)
  `;
});
