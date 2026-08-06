# Scheduled automations

> For maintainers. Using T3 Code? See [docs/user](../user/).

Scheduled automations are a downstream-owned, single-process facility for
durable cron-triggered T3 turns. The server is the only scheduler authority;
clients manage definitions over the existing authenticated WebSocket session.
Consequently `scheduledAutomation.*` RPCs and subscriptions have the same local,
remote/relay, and tunnel behavior as other environment RPCs and must not embed
origin-specific URLs.

## Boundaries and ownership

The durable and protocol namespace is deliberately specific:

- contract and RPC: `scheduledAutomation`;
- SQLite: `local_scheduled_automations_v1`;
- deterministic ThreadId prefix: `t3sa:v1`;
- branch prefix: `t3/local-scheduled-automation`;
- worktree subtree: `local-scheduled-automations-v1`;
- activity prefix: `local-scheduled-automation`.

`Automations` is only the user-facing label. The SQLite table is downstream-owned
and schema-versioned; no code outside `ScheduledAutomationRepository` should
depend on its shape. One server process owns scheduling for one database. There
is no distributed lease and two schedulers must never target the same database.

An occurrence is `(automationId, scheduledFor)`. Shared identity helpers derive
its thread, message, command, branch, and worktree path. The repository advances
the schedule cursor with compare-and-swap before bootstrap. The resumable
`ThreadBootstrapService` uses deterministic phase command IDs and checks command
receipts, projection state, and live Git state after interruption. The scheduler
reconciles a durable `starting` outcome before evaluating another occurrence.

The durable guarantee ends at the accepted `thread.turn.start` intent. Provider
delivery happens later through `ProviderCommandReactor`, which consumes a hot,
non-replayed domain-event stream. A process crash after the command receipt is
committed but before `ProviderService.sendTurn` can therefore lose that delivery;
a crash around an external provider acknowledgement can also make delivery
ambiguous. Automation v1 has no durable provider outbox or cross-provider
idempotency key and does not promise exactly-once provider execution.

Provider adapters need no automation-specific path: the definition selects an
existing live provider instance, model, runtime mode, and interaction mode, and
the ordinary bootstrap path emits the turn-start intent. Live capability
validation runs when enabling and claiming, so unsupported selections fail
closed. Setup scripts are always skipped because the current PTY setup runner has
no durable completion receipt.

The latest-only planner uses the definition's IANA time zone and considers only
cron instants after `enabledAt` and the last cursor. After downtime, older missed
instants are counted but only the latest is claimed. Overlap is per definition:
an active previous turn records `skipped-active`; a terminal but unsettled turn
does not block the next deterministic occurrence.

## Surfaces and retention

Web owns the Settings management route and command-palette entry; desktop wraps
that surface. Mobile deliberately has no definition-management route in v1, but
automation threads decode and render through the shared thread contracts. Slack
App Home treats active automation threads as ordinary deep-linked directory
entries and adds no live hub behavior.

The global housekeeper discovers candidates from retained projection data, not
definition rows, so deletion does not escape retention. Active and recent
candidates are deferred without an activity. The housekeeper removes a worktree
without force only after independent thread, branch, configured-root path, Git
registration, inactivity, age, and cleanliness checks agree. Successful removal
retains the branch and all T3 history and appends a deterministic pruned
activity; ownership, cleanliness, inspection, and removal failures append a
deterministic blocked activity when that refusal can be recorded safely.

## Future upstream consolidation

Never dual-run the local scheduler and a future upstream scheduler. Cut over in
this order:

1. Disable the local scheduled-automation scheduler.
2. Import definitions through `ScheduledAutomationRepository`; do not read the
   local table from new scheduling code.
3. Verify definition counts, revisions, activation boundaries, cursors, outcomes,
   and deterministic thread links.
4. Enable the upstream scheduler only after verification succeeds.
5. Retain `local_scheduled_automations_v1` read-only until cutover is confirmed.

If import or verification fails, keep both schedulers disabled and resolve the
mapping before retrying. Do not repair ambiguity by scheduling from both models.
