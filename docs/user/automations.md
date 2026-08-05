# Automations

Automations run a prompt on a five-field cron schedule in a chosen IANA time
zone. New definitions are disabled. Review the project, model, workspace policy,
and schedule before enabling one.

The Automations settings page shows the latest occurrence, its current status,
the schedule cursor, any coalesced occurrences, and a link to the T3 thread that
records the run. A missing linked thread is reported explicitly. Disabling an
automation prevents future occurrences but does not interrupt work already in
progress.

## Recover a failed occurrence

1. Disable the automation so it cannot claim another occurrence while you
   investigate.
2. Open the linked thread and inspect its branch and worktree. Failed and partial
   artifacts are retained for diagnosis.
3. Use **Retry last** only when the failure is marked retryable. A retry resumes
   the same occurrence and reuses its existing thread and worktree identity.
4. For a rejected phase or a correction to the project or worktree policy,
   choose **Abandon last occurrence** first. Confirming abandonment ends
   retry for that occurrence but does not delete its thread, branch, or worktree.
5. Correct the definition and re-enable it. The next eligible schedule creates a
   new occurrence; the abandoned artifacts remain available for inspection.

Automations skip project setup scripts in v1. A current-workspace automation
shares files with users and other automations; use a new worktree when unattended
changes should be isolated.
