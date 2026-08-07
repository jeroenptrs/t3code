# Automations

Automations run a prompt on a five-field cron schedule in a chosen IANA time
zone. New definitions are disabled. Review the project, model, workspace policy,
and schedule before enabling one.

Automations in a database are owned by one T3 server process. The schedule uses
the chosen time zone, including daylight-saving transitions, and the
`latest-only` misfire policy: after downtime, T3 runs only the newest eligible
occurrence instead of replaying every missed minute. An occurrence is durably
claimed before its thread starts. Restart recovery resumes that same
deterministic thread and, for new-worktree runs, its worktree. T3 durably records
the turn-start intent, but provider delivery happens afterward and can be lost or
duplicated around a server or provider crash. Automation v1 does not claim
exactly-once execution across multiple server processes or external provider
side effects.

The Automations settings page shows the latest occurrence, its current status,
the schedule cursor, any coalesced occurrences, and a link to the T3 thread that
records the run. A missing linked thread is reported explicitly. Disabling an
automation prevents future occurrences but does not interrupt work already in
progress.

Web and desktop can create and manage definitions. Automation threads use the
ordinary thread contracts, so they remain visible on mobile and in supported
thread directories such as Slack App Home; mobile definition management and a
Slack live automation hub are not part of v1. Local, remote/relay, and tunnel
clients use the same authenticated T3 connection—no origin-specific automation
configuration is required.

## Recover a failed occurrence

1. Disable the automation so it cannot claim another occurrence while you
   investigate.
2. Open the linked thread. For a new-worktree run, inspect its branch and
   worktree. Failed and partial artifacts are retained for diagnosis.
3. Use **Retry last** only when the failure is marked retryable. A retry resumes
   the same occurrence and reuses its thread identity and, for a new-worktree
   run, its worktree identity.
4. For a rejected phase or a correction to the project or worktree policy,
   choose **Abandon last occurrence** first. Confirming abandonment ends
   retry for that occurrence but does not delete its thread, branch, or worktree.
5. Correct the definition and re-enable it. The next eligible schedule creates a
   new occurrence; the abandoned artifacts remain available for inspection.

Automations skip project setup scripts in v1. A current-workspace automation
shares files with users and other automations; use a new worktree when unattended
changes should be isolated.

## Retention and deletion

New-worktree runs are eligible for cleanup only after the global retention
period and only when T3 can prove the thread, branch, registered Git worktree,
and owned path all describe the same automation occurrence. Active or recent
worktrees are deferred until eligible. Dirty, ownership-mismatched, unreadable,
or failed-removal cases are retained and reported as blocked. An already-absent
worktree can be reconciled as pruned when Git confirms its retained branch is no
longer registered to a path. Cleanup is non-force and retains the Git branch and
T3 thread history.

Deleting a disabled definition deletes only that definition. It does not delete
threads, messages, branches, worktrees, checkpoints, terminal history, or an
already-running provider turn. Eligible owned worktrees remain subject to the
same global retention policy even after their definition is deleted.
