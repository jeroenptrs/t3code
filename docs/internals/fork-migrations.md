# Fork migrations

Fork-only migrations live in `apps/server/src/persistence/ForkMigrations/` and
run from their own ledger table, `fork_sql_migrations`, after upstream's
migrations. The migrator skips every id at or below the highest one recorded,
so a fork migration numbered inside upstream's sequence would make upstream's
own migration at that id never run after a rebase. Every caller of
`runMigrations()` that opens a real database also calls `runForkMigrations()`
right after it.

## What a fork migration may do

Because they run after upstream, fork migrations may create fork-owned tables
and add columns or indexes to upstream tables. They must not rename, drop, or
rebuild upstream tables or change upstream columns: a later upstream migration
assumes upstream's schema and would conflict with or undo it.

Columns added to upstream tables are lost if upstream later recreates the
table, and the fork ledger does not notice. When rebasing, check new upstream
migrations for rebuilds of the tables listed below and add a fork migration
that restores the fork columns.

## Inventory

Fork columns on upstream tables:

- `auth_sessions.user_id` (002)
- `scheduled_tasks.created_by_user_id`, `webhook_token_rotated_by_user_id`,
  `webhook_token_rotated_at` (003)
- `scheduled_task_webhook_deliveries.dispatched_at` (004)
- `scheduled_tasks.triage_json` (018)

Fork-owned tables:

- `auth_users`, `auth_user_access_changes` (001)
- `fork_diff_walkthroughs` (005, documents rewritten by 006)
- `fork_projection_thread_jira_issues` (007, `watch_json` added by 010)
- `fork_jira_user_credentials` (008)
- `fork_jira_proposals` (009)
- `fork_jira_remote_links` (011)
- `fork_jira_breakdowns` (012)
- `fork_insights_settings`, `fork_insights_projects`,
  `fork_insights_contributors`, `fork_insights_contributor_emails`,
  `fork_insights_merge_requests`, `fork_insights_mr_reviews`,
  `fork_insights_commits` (013)
- `fork_insights_jira_issues` (014)
- `fork_auth_step_up_bindings` (015)
- `fork_factory_threads` (016)
- `fork_trigger_observations` (017)
- `fork_factory_work_items`, `fork_factory_work_item_threads`,
  `fork_factory_work_item_transitions` (019)

Fork indexes on upstream tables:

- `idx_fork_turn_items_waiting_jira_proposals` on
  `orchestration_v2_projection_turn_items` (009)
- `idx_fork_messages_scheduled_task` on
  `orchestration_v2_projection_messages` (016)
