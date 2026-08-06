# Scheduled automation rollout and recovery

> For maintainers. Using T3 Code? See [docs/user](../user/).

Automation v1 is a single-process scheduler. Before enabling it, confirm exactly
one T3 server process owns the target SQLite database. Never run local and future
upstream schedulers against the same definitions or database.

## Deliberately small rollout

Broader unattended rollout is gated on this sequence:

1. Create one definition and leave it disabled. Confirm its project, live
   provider/model capability, five-field cron expression, IANA time zone,
   `latest-only` policy, and `setupScriptPolicy: skip` in Settings.
2. Enable one observable, read-only prompt in the current workspace. Confirm one
   claimed cursor, linked thread, initial user message, and accepted turn-start
   intent. Inspect whether the provider received the turn, but do not treat that
   external delivery as exactly-once evidence. Disable the definition after
   inspection. Remember that the current workspace is shared with users and
   other automations.
3. Use a controlled new-worktree definition and restart the owning server during
   an occurrence. Confirm recovery reuses the same `t3sa:v1` thread, message,
   branch/worktree identity, and phase receipts rather than creating duplicates.
4. Enable one new-worktree definition with a long interval and an observable,
   non-destructive prompt. Confirm its path is below
   `local-scheduled-automations-v1` and its branch begins
   `t3/local-scheduled-automation`.
5. After the configured retention period, confirm a clean inactive worktree is
   removed without force, its branch and T3 history remain, and the thread has a
   `local-scheduled-automation.worktree.pruned` activity. Exercise a dirty
   worktree too and confirm it is retained with a blocked activity.
6. Record the definition ID, scheduled instant, linked thread, restart point,
   phase receipts, worktree path, retained branch, and prune result. Enable more
   unattended definitions only after all evidence is inspectable.

Automation v1 guarantees deterministic reconciliation of T3's durable claim,
accepted turn-start intent, receipts, projection, and owned Git identity. It does
not guarantee delivery of a provider turn across a crash, exactly-once external
provider side effects, replay every missed cron instant, or coordination between
multiple scheduler processes.

## Investigating a failure

1. Disable the definition. This prevents future claims but does not interrupt a
   running thread.
2. Inspect scheduler health and the definition's outcome code, retryable flag,
   cursor, linked thread, and coalesced count.
3. Inspect the linked thread and Git registration. Partial worktrees and branches
   are intentionally retained.
4. Use **Retry last** only for a retryable failure. Retry resumes the same
   occurrence identity; it does not mint a replacement run.
5. For a non-retryable rejected occurrence, keep the definition disabled,
   abandon the occurrence, correct the definition, and then re-enable it.

Deleting a disabled definition is not cleanup: it leaves threads, messages,
branches, worktrees, checkpoints, terminal history, and running provider work
untouched. The projection-owned retention scan can still prune a provably owned,
old, inactive, clean worktree after its definition is gone.

When pruning is blocked, resolve the recorded reason instead of force-removing
the path. A dirty or ownership-mismatched worktree is evidence to preserve.
