# Automation v1 — Durable Scheduled Runs

## Status

Implementation plan. No automation contracts, persistence, scheduler, or UI exist
yet. The shared `ThreadBootstrapService` required by this workstream already
exists, but it is not phase-resumable and must be hardened before a scheduler can
use it safely.

The product boundary in
`docs/user/slack-jira-ingress-design.md` remains authoritative. This plan resolves
the automation implementation shape that document intentionally left open.

## Feasibility and phase recommendation

Automation v1 is feasible as **one coordinated feature phase** with sequential,
independently verifiable work packages. It is not a responsible one-PR or
one-cutover change.

The work crosses three risk classes:

1. ordinary product state and management UI;
2. durable time-based execution and restart reconciliation;
3. destructive Git worktree pruning.

Treat the work packages below as merge gates inside one feature phase. Keep every
automation disabled by default, and do not enable unattended new-worktree runs in
a release until the pruning package and final restart qualification pass.

This assessment assumes the following v1 boundary:

- one scheduler owner per T3 server process and one SQLite database; no
  active/active server cluster or distributed lease;
- cron schedules only; no webhooks, Jira triggers, chaining, loops, or graphs;
- one prompt and no attachments per occurrence;
- Web and desktop management UI; no mobile CRUD UI in v1;
- automation-created threads remain visible on mobile through the existing shell
  and thread contracts;
- no run-history or job table; the T3 thread is the run record;
- no automatic retry storm; crash recovery resumes an occurrence that was claimed
  but not conclusively dispatched, while ordinary execution failures require an
  explicit retry or the next scheduled occurrence;
- setup scripts are **disabled for unattended automation v1**. The current setup
  runner launches a command through a PTY and has no durable completion receipt,
  so exactly-once recovery across a process crash cannot be proved from current
  state. The definition still carries an explicit `setupScriptPolicy`, whose only
  enableable v1 value is `"skip"`. A future `"run-once"` value requires a durable,
  receipt-producing setup runner and is not silently approximated here.

If `run-once` setup scripts, active/active scheduling, mobile management, or run
history are required in the first release, split this into at least two delivery
phases. Those requirements add new durable state or a new execution protocol and
invalidate the single-phase assessment.

## Goal

Let a user define, enable, observe, disable, retry, and delete a scheduled
automation that starts a deterministic T3 conversation at each eligible cron
occurrence. The server must adjudicate occurrences durably, recover after restart
without duplicate threads or worktrees, skip overlap while the previous run is
active, and eventually prune only worktrees it can prove it owns and can prove are
safe to remove.

## Non-goals

- Jira ingress or Jira-triggered automations.
- Automation chaining, loops, graphs, conditional steps, or context seeding.
- A durable job queue, run table, event-sourced automation aggregate, or external
  scheduler.
- More than one prompt/turn per occurrence.
- Automatic retries with backoff after a conclusive run failure.
- Interrupting a running thread when its automation is disabled or deleted.
- Deleting T3 threads, branches, checkpoint refs, or terminal history during
  worktree pruning.
- Using thread settlement as run activity truth.
- Running setup scripts for unattended occurrences until they have a durable
  completion protocol.
- Daytona or another sandbox/runtime boundary.

## Locked v1 semantics

These choices make the implementation decision-complete. Re-open them explicitly
instead of choosing different behavior while implementing a later work package.

### Downstream namespace and upstream consolidation seam

`Automations` remains the user-facing product label. Generic durable and protocol
names do not. This downstream implementation uses:

```text
Domain type:       ScheduledAutomation
Contract module:   scheduledAutomation.ts
RPC namespace:     scheduledAutomation.*
SQLite table:      local_scheduled_automations_v1
Thread prefix:     t3sa:v1
Worktree subtree:  <worktreesDir>/local-scheduled-automations-v1
```

The SQL name is intentionally downstream-owned and schema-versioned. Do not use a
plain `automations` table: SQLite table names are global, and an upstream
`CREATE TABLE IF NOT EXISTS automations` with a different shape could otherwise
be silently mistaken for this feature's storage. The local migration either
creates the exact v1 schema or fails loudly when its own namespaced table already
exists with an incompatible shape; it never adopts a table based only on its
name.

All scheduler and management code accesses persistence through
`ScheduledAutomationRepository`; it never imports SQL/table details directly.
This is the future consolidation seam. If upstream ships a compatible automation
feature, a later migration can read the local v1 definitions through that
repository, map them into the upstream model, disable the local scheduler before
enabling the upstream scheduler, verify counts/cursors/thread links, and retain
the local table read-only until cutover is confirmed. Do not dual-schedule the
same definition during migration.

Source-level route or type conflicts are allowed to surface normally in Git and
TypeScript during a rebase. The special namespacing is for durable SQLite,
protocol, thread-identity, and filesystem values that could survive code changes
or collide silently. Migration numbers remain integration-order identifiers and
must be renumbered on rebase if upstream claims the next number; the stable table
and contract namespaces do not change.

### Definition

An automation stores:

```ts
interface ScheduledAutomation {
  id: ScheduledAutomationId;
  revision: number;
  name: string;
  prompt: string;
  projectId: ProjectId;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  worktreePolicy:
    | { kind: "current" }
    | {
        kind: "new-worktree";
        baseBranch: string;
        startFromOrigin: boolean;
      };
  setupScriptPolicy: "skip";
  schedule: {
    cron: string;
    timeZone: string;
    misfirePolicy: "latest-only";
  };
  enabled: boolean;
  enabledAt: string | null;
  lastScheduledFor: string | null;
  lastThreadId: ThreadId | null;
  lastOutcome: ScheduledAutomationOutcome | null;
  createdAt: string;
  updatedAt: string;
}
```

`cron` is the five-field syntax accepted by Effect's `Cron`/`Schedule.cron`
implementation. `timeZone` is a required IANA time-zone identifier. The server,
not the browser, parses both and returns a typed validation error.

`ModelSelection`, `RuntimeMode`, and `ProviderInteractionMode` reuse the existing
orchestration contracts. Provider/model/options are validated against the live
server catalog when a definition is enabled and again when an occurrence is
claimed. A definition may remain stored while its project or provider is
temporarily unavailable, but it cannot produce a new thread until valid again.

`current` deliberately shares the selected project's current workspace and gives
no filesystem isolation from other automations. The UI must say so. The overlap
rule is per automation, not a global project lock. Git-backed unattended write
automations should use `new-worktree`.

`new-worktree` is valid only for a live Git project and requires a live base ref.
Each occurrence gets a deterministic branch and an explicit path below the
server's configured worktree root:

```text
branch: t3/local-scheduled-automation/<automation-id>/<occurrence-key>
path:   <worktreesDir>/local-scheduled-automations-v1/<automation-id>/<occurrence-key>
```

The exact ID-safe encoding belongs in one shared helper and is snapshot-tested.
It must not contain the prompt or secrets.

### Commands and concurrency

Contracts define these commands:

- `scheduledAutomation.create`
- `scheduledAutomation.update`
- `scheduledAutomation.enabled.set`
- `scheduledAutomation.retry-last`
- `scheduledAutomation.delete`

Update, enable/disable, retry, and delete carry `expectedRevision`. The repository
uses a compare-and-swap update and returns a typed conflict containing the current
row when another client has changed it. Create is disabled by default. Delete is
allowed only while disabled and deletes only the automation row; its T3 threads,
branches, and worktrees remain governed by normal retention.

Disabling or deleting an automation prevents future claims but never interrupts
or deletes an already-started thread. Enabling sets `enabledAt` to the server
clock; only cron instants strictly after that activation boundary are eligible.
Disabling clears `enabledAt`. Re-enabling therefore does not replay occurrences
from the explicitly disabled interval. A process restart preserves `enabledAt`,
so downtime while the definition remained enabled still follows the catch-up rule
below.

### Occurrence identity and cursor

An occurrence is identified by `(automationId, scheduledFor)`, where
`scheduledFor` is the UTC instant selected by the parsed cron schedule. Derive the
thread, message, bootstrap command, and bootstrap phase IDs deterministically from
that tuple.

```text
t3sa:v1:<automation-key>:<occurrence-key>:thread
```

`lastScheduledFor` is the latest schedule occurrence the server has durably
adjudicated, not the wall-clock time execution happened.

On restart, `latest-only` coalesces all due occurrences newer than the cursor and
strictly after `enabledAt` to the newest one at or before `now`. Earlier missed
instants are not run and do not become rows. Record their count in the latest
outcome for operator visibility. This prevents a long-offline laptop or VM from
starting a backlog storm while preserving a truthful cursor. A newly enabled or
re-enabled definition waits for its next cron instant.

### Claim and reconciliation protocol

For a due occurrence:

1. Read the previous `lastThreadId` and derive activity from its current T3 shell.
2. If active, atomically advance `lastScheduledFor` and write
   `lastOutcome = skipped-active`; keep `lastThreadId` pointing at the previous
   run and create no thread.
3. Otherwise, compare-and-swap the row to the new cursor, deterministic ThreadId,
   and `lastOutcome = starting` before any Git or provider side effect.
4. Dispatch through the in-process `ThreadBootstrapService`.
5. On accepted turn start, write `lastOutcome = started`.
6. On a conclusive failure, retain the deterministic ThreadId and write a typed,
   bounded, secret-safe `failed` outcome.
7. If the process exits after step 3 and before step 5/6, startup reconciliation
   sees `starting`, inspects the deterministic thread/worktree/receipts, and
   resumes only missing bootstrap phases.

`retry-last` is allowed only for `failed`. It reuses the same occurrence IDs and
does not move `lastScheduledFor`. It is therefore a reconciliation command, not a
new run.

### Active-run truth

The previous run is active when **any** of these is true in its current
`OrchestrationThreadShell`:

- session status is `starting` or `running`;
- `hasPendingApprovals` is true;
- `hasPendingUserInput` is true;
- `hasQueuedTurnStart(shell, now)` is true using the existing two-minute,
  clock-skew-bounded rule;
- `latestTurn.state` is `running`.

`completed`, `error`, and `interrupted` latest turns are terminal. A missing
thread is inactive. Settlement, snooze, archive state, and age by themselves are
not activity signals. Put this predicate in a server-owned pure helper with a
table-driven test; do not create a third subtly different interpretation inside
the scheduler.

### Outcome truth

The durable row records occurrence adjudication. `ScheduledAutomationOutcome` is
a tagged value containing `scheduledFor`, `observedAt`, and `coalescedCount`, plus:

- `starting` — the occurrence is claimed and reconciliation is incomplete;
- `started` — the deterministic turn-start command was accepted;
- `skipped-active` — the previous run was active, including its ThreadId;
- `failed` — a stable failure code and bounded, secret-safe detail.

The read API derives the operator-facing state by joining `lastThreadId` to the
live shell projection:

- `never-run`
- `starting`
- `running`
- `blocked`
- `completed`
- `failed`
- `interrupted`
- `skipped-active`
- `thread-missing`

This is a view, not another stored lifecycle. A `skipped-active` or `failed`
adjudication remains the primary visible state even if the previously linked
thread later changes; the view may show that thread's current state secondarily.
For `starting`/`started`, live thread state supplies the primary visible state. A
missing current occurrence thread yields `thread-missing`. There is no historical
outcome list in v1; older executions remain discoverable as ordinary T3 threads.

### Scheduler topology

Use one scoped coordinator fiber, not one permanent fiber or timer per
automation. The coordinator computes the nearest due instant across enabled rows,
wakes on either that instant or an in-memory definition-change signal, then
re-reads SQLite before claiming. Tests use an injected clock and receipts; they do
not sleep or poll.

The process assumes sole scheduler ownership of its SQLite database. The atomic
cursor compare-and-swap still protects reconnecting clients and accidental
duplicate evaluation in one process, but it is not advertised as a distributed
lease.

### Worktree retention

Retention is one server setting,
`localScheduledAutomationWorktreeRetentionDays`, with a seven-day default.
Housekeeping evaluates candidates at startup and at most once every six hours.
Changing retention applies to all automation-owned worktrees, including runs
whose automation definition was deleted. Per-automation retention would need
durable per-run policy and is deferred.

A worktree is automation-owned only when all independent markers agree:

1. ThreadId parses as a v1 automation occurrence.
2. Thread branch parses to the same automation and occurrence keys.
3. Canonical worktree path is a strict descendant of
   `<worktreesDir>/local-scheduled-automations-v1/<automation-id>/<occurrence-key>`.
4. Git's live worktree list for the project reports that exact canonical path and
   branch.

Failure to prove any marker means skip, never guess.

## Sources of truth and test oracles

Acceptance criteria below use these authorities in order:

| Question | Authoritative evidence |
| --- | --- |
| Was a schedule occurrence adjudicated? | `local_scheduled_automations_v1.last_scheduled_for` plus the row revision |
| Was a command accepted already? | orchestration command receipt for its deterministic CommandId |
| Does the run/thread exist and what state is it in? | projection shell/detail snapshot |
| Was a bootstrap phase completed? | deterministic command receipt plus projected thread metadata/activity |
| Does a worktree exist and which branch owns it? | Git live worktree/ref query, not only a stored path |
| Is a worktree clean? | fresh local Git status from the worktree immediately before removal |
| Was a worktree pruned? | successful non-force `git worktree remove`, absent live worktree entry, and appended T3 activity |
| What does the UI claim? | decoded automation read model from the server; the browser does not infer lifecycle from timers |

Logs, in-memory fibers, Slack messages, UI toasts, and wall-clock time are
observability signals, not durable proof.

## Work package 0 — Decision lock and executable domain fixtures

### Purpose

Turn the choices above into schemas and pure fixtures before persistence or UI
work makes them expensive to change.

### Implementation

- Add `packages/contracts/src/scheduledAutomation.ts` and export it from the
  contracts package.
- Define branded `ScheduledAutomationId`, definition/outcome/read-view schemas,
  command union, errors, and `scheduledAutomation.*` RPC payload schemas.
- Extend the existing bootstrap prepare-worktree contract with an optional,
  server-validated target path. Existing web/Slack clients omit it; automation
  uses it to stay inside the deterministic ownership namespace.
- Add pure ID derivation and cron validation/next-occurrence helpers in the
  smallest shared server/contract boundary that does not pull server runtime code
  into clients.
- Add the active-run predicate next to server scheduled-automation execution code.
  Reuse or extract the existing queued-turn helper so the two-minute and
  clock-skew rules have one implementation.
- Document the five-field cron, required timezone, latest-only misfire policy,
  current-workspace warning, and setup-script exclusion in contract comments and
  tests.

### Acceptance criteria

- Schema tests accept every existing `RuntimeMode` and
  `ProviderInteractionMode`, preserve a ragged `ModelSelection.options`, and
  reject empty name/prompt, invalid cron, invalid timezone, and unsupported setup
  policy.
- Snapshot tests prove the same `(automationId, scheduledFor)` always yields the
  same ThreadId, MessageId, phase CommandIds, branch, and worktree path, while two
  different occurrences yield different values.
- ID snapshots contain neither prompt text nor model/provider credentials.
- Cron fixtures cover UTC, a non-UTC zone, a daylight-saving gap, a repeated
  daylight-saving hour, and multiple missed occurrences under `latest-only`.
- The active predicate's table covers every session status, all four latest-turn
  states, pending approval, pending input, a fresh queued start, an expired queued
  start, missing thread, settled thread, and completed-but-unsettled thread.
- The completed-but-unsettled fixture is inactive, proving settlement is not used
  as overlap truth.

### Verification

```text
vp test run packages/contracts/src/scheduledAutomation.test.ts \
  apps/server/src/scheduledAutomation/ScheduledAutomationOccurrence.test.ts
vp run --filter @t3tools/contracts --filter t3 typecheck
```

### Exit gate

No database or UI code starts until contract names, misfire behavior, activity
truth, and the setup-script exclusion are reviewed as a coherent set.

## Work package 1 — Single-row persistence and management service

### Purpose

Make definitions durable and safely mutable without starting scheduled work yet.

### Implementation

- Add the next available numbered migration with exactly one
  `local_scheduled_automations_v1` table, a `schema_version = 1` constraint, and
  useful enabled/cursor indexes. Do not create or inspect a plain `automations`
  table. Store structured contract values as schema-decoded JSON where that is
  already the repository convention.
- Add a `ScheduledAutomationRepository` with
  list/get/create/CAS-update/CAS-delete and an atomic occurrence-claim operation.
  Keep SQL and decoding errors typed, and keep the table name private to this
  repository.
- Add a `ScheduledAutomationService` that validates live
  project/provider/ref capability, handles management commands, and publishes
  in-memory changes after commit.
- Add WS RPC methods for command dispatch, list/get, and a snapshot-plus-change
  subscription. Read methods require `orchestration:read`; mutation methods
  require `orchestration:operate`.
- Do not add an automation event store, run table, job table, retry table, or
  client-owned persistence.

### Acceptance criteria

- A migration test upgrades a database through the prior migration, then through
  the automation migration, and can decode a fully populated row through the
  public contract.
- A database pre-seeded with an unrelated, incompatible `automations` table
  migrates successfully; that table remains byte-for-byte/schema-for-schema
  untouched while `local_scheduled_automations_v1` is created independently.
- A database pre-seeded with an incompatible
  `local_scheduled_automations_v1` shape fails migration loudly instead of being
  accepted through `CREATE TABLE IF NOT EXISTS`.
- Every local row carries schema version 1, and repository decoding rejects an
  unknown schema version before scheduler code can observe the row.
- Restarting the repository layer against the same temporary SQLite file returns
  byte-equivalent definitions and cursor/outcome values.
- Create always writes `enabled = false`, `enabledAt = null`, `revision = 1`, and
  null run fields.
- Every successful mutation increments revision exactly once; a stale
  `expectedRevision` changes no columns and returns the current row in a typed
  conflict.
- Enabling rejects a missing/deleted project, unavailable provider instance,
  unsupported model option, invalid base ref, non-Git new-worktree target, and any
  setup policy other than `skip`.
- Disabling succeeds even when dependencies have become unavailable.
- Delete is rejected while enabled. A successful delete leaves orchestration
  events, projections, branches, and worktree directories untouched.
- Subscription tests receive an initial SQLite-backed snapshot and committed
  upsert/remove changes; a fresh subscription after process restart reconstructs
  the same snapshot without relying on PubSub history.
- Authorization tests prove a read-only session cannot mutate and an operate-only
  session cannot subscribe unless it also has read scope.
- SQLite schema inspection finds `local_scheduled_automations_v1`, does not find a
  locally created plain `automations` table, and finds no local automation
  run/job/history table.
- A repository-boundary test proves the scheduler/service consume only
  `ScheduledAutomationRepository` operations and do not embed the SQL table name.

### Verification

```text
vp test run apps/server/src/persistence/Migrations/036_LocalScheduledAutomationsV1.test.ts \
  apps/server/src/scheduledAutomation/ScheduledAutomationRepository.test.ts \
  apps/server/src/scheduledAutomation/ScheduledAutomationService.test.ts \
  apps/server/src/scheduledAutomation/scheduledAutomationRpc.test.ts
vp run --filter @t3tools/contracts --filter t3 typecheck
```

### Exit gate

Definitions survive restart and all management mutations are CAS-protected. The
scheduler still does not run.

## Work package 2 — Web and desktop management vertical

### Purpose

Let users manage the durable definitions through the existing remote-capable WS
boundary before execution is activated.

### Implementation

- Add `/settings/automations` and include it in Settings navigation and Settings
  search.
- Add an `Open automations` command-palette action. No dedicated keybinding is
  required in v1; the command palette is the keyboard entry point.
- Render an environment-wide list with name, enabled state, schedule plus
  timezone, next occurrence, project, model/effort, worktree mode, last outcome,
  and last-thread link.
- Add create/edit forms backed by live shell projects and live provider/model
  capabilities. Branch choices refresh when project/worktree mode changes and
  are revalidated by the server on submit.
- Make `Current workspace` disclose that it is shared and not isolated. Make
  `New worktree` disclose the retention behavior.
- Implement enable/disable, retry-last, and delete confirmation. A conflict
  replaces local state with the server row and asks the user to review again; it
  must not silently overwrite another device's change.
- Add client-runtime request/state helpers if both web and mobile need to decode
  automation views. Do not put browser-only state in contracts.

### Acceptance criteria

- Component tests create and edit all definition fields and assert the exact
  command payload sent over RPC.
- The model selector only emits combinations present in that model's live
  capability descriptors; it does not assume a common effort set.
- Selecting a different project clears an invalid branch and model default rather
  than submitting stale values.
- Invalid cron/timezone errors returned by the server are rendered on the
  corresponding controls; the browser's preview is advisory only.
- A stale-revision response never retries the write automatically and visibly
  presents the current server definition.
- Disable leaves the linked running thread unchanged. Delete requires a disabled
  row and explicitly says it does not delete prior threads/worktrees.
- The route and command-palette action work in the web build and the Electron
  wrapper without Electron-specific RPC.
- Settings navigation/search tests include Automations, and generated route-tree
  changes are committed if the router generator updates them.
- Mobile decision is recorded: no automation management route in v1; existing
  thread list/detail behavior remains the mobile execution view.

### Verification

```text
vp test run apps/web/src/components/settings/AutomationsSettings.test.tsx \
  apps/web/src/components/settings/settingsSearch.test.ts \
  apps/web/src/commands/scheduledAutomationCommands.test.ts
vp run --filter @t3tools/web --filter @t3tools/client-runtime typecheck
```

### Exit gate

The UI is contract-complete, but production rollout still keeps automations
disabled because bootstrap recovery and scheduling have not passed.

## Work package 3 — Phase-resumable thread bootstrap

### Purpose

Make the already-extracted service safe for an in-process durable trigger.

### Current truth to change

The present `ThreadBootstrapService`:

- is constructed directly inside each WS RPC layer instead of consumed as one
  shared runtime service;
- creates random server CommandIds/EventIds for every phase;
- unconditionally attempts `thread.create` again on retry;
- deletes a thread it created when many later phases fail, while a Git worktree
  may already exist;
- may rerun a setup script because setup launch has no durable completion
  receipt.

### Implementation

- Install one `ThreadBootstrapService` layer in the server runtime and inject the
  service into WS and scheduled-automation callers.
- Derive stable phase command/activity IDs from the caller's deterministic start
  CommandId.
- Before each phase, inspect projection detail and let command-receipt dedupe
  adjudicate already-accepted mutations.
- For deterministic new-worktree bootstraps, pass an explicit automation path to
  Git. On retry, require the deterministic branch and live Git worktree path to
  agree before reusing it.
- Keep partial threads/worktrees on a recoverable bootstrap failure. Append a
  bounded, secret-safe failure activity instead of deleting the thread and losing
  the recovery anchor.
- Preserve existing WS behavior for ordinary successful client bootstraps.
- Do not advertise setup-script crash safety. Existing interactive/Slack setup
  behavior may keep its best-effort launch semantics; automation v1 always sends
  `runSetupScript: false`.

### Acceptance criteria

- Failure-injection tests stop after thread create, Git worktree create, thread
  metadata update, and final turn dispatch. Re-running the same command after
  each stop produces exactly one thread, one live worktree, one initial message,
  and one accepted turn-start receipt.
- A retry after worktree creation but before metadata update discovers the live
  deterministic branch/path and finishes the metadata phase without calling
  `git worktree add` again.
- A mismatched existing path or branch fails closed and neither adopts nor removes
  that worktree.
- A final-turn dispatch timeout reconciles through receipt/message truth and does
  not send a second provider turn.
- A conclusive failure retains the partial thread and appends one deterministic
  bootstrap-failed activity. Retrying does not duplicate the activity.
- Existing successful WS bootstrap server tests remain green and still prove
  switch-ref, worktree, setup-launch, and no-worktree paths.
- Scheduled-automation service tests prove `setupScriptPolicy: skip` produces no
  call to `ProjectSetupScriptRunner`.

### Verification

```text
vp test run apps/server/src/orchestration/Services/ThreadBootstrapService.test.ts \
  apps/server/src/server.test.ts \
  apps/server/src/scheduledAutomation/ScheduledAutomationBootstrap.test.ts
vp run --filter t3 typecheck
```

Run only the named bootstrap cases from `server.test.ts` if the test runner
supports a name filter; do not turn this work package into a repo-wide test run.

### Exit gate

The same deterministic bootstrap can be resumed after every durable phase and no
test observes a duplicate thread, worktree, message, or turn.

## Work package 4 — Occurrence planner, durable claim, and scheduler

### Purpose

Start eligible automations at the right instant and reconcile crashes without a
job queue.

### Implementation

- Add a pure occurrence planner around Effect Cron and an injected clock.
- Add the atomic claim operation described above. Claim and cursor advance occur
  in one SQLite transaction/CAS before bootstrap side effects.
- Add one scoped `ScheduledAutomationScheduler` coordinator to server startup
  after migrations, projections, and command readiness are available.
- Wake the coordinator on nearest due time or committed definition change. On
  wake, re-read enabled rows and the clock; never trust a stale in-memory row.
- Serialize claims per `ScheduledAutomationId` in process. The SQLite CAS remains
  the final arbiter.
- Reconcile durable `starting` outcomes on startup before claiming later
  occurrences for that automation.
- Implement `retry-last` through the same reconciliation path.
- Log/measure claims, starts, skips, failures, reconciliation, and clock/misfire
  decisions with IDs and status only; never log prompts.

### Acceptance criteria

- With a fake clock, an enabled definition starts exactly once at a due instant;
  repeated ticks and duplicate definition-change signals do not change the row or
  dispatch again.
- Disabled definitions never claim. Enabling sets a durable activation boundary
  and waits for the first cron instant after it; re-enabling never replays the
  disabled interval.
- Restart while still enabled preserves that activation boundary and coalesces
  missed instants to the latest due occurrence.
- Restart before claim claims once; restart after `starting` and before bootstrap
  resumes the same ThreadId; restart after accepted start performs no new side
  effect.
- A database assertion after each crash point shows monotonic
  `lastScheduledFor`, a single row, and the expected revision/outcome.
- `latest-only` tests covering 1, 10, and 10,000 missed instants claim at most one
  run and record the truthful coalesced count without a long synchronous loop.
- Every active-truth fixture yields `skipped-active`, advances the cursor, keeps
  the previous `lastThreadId`, and creates no orchestration event for the skipped
  occurrence.
- A completed-but-unsettled previous thread allows the next run.
- A conclusive bootstrap/configuration failure records `failed` with a bounded
  typed detail. It does not retry until `retry-last` or the next schedule.
- `retry-last` is rejected for running/started/skipped states and, when allowed,
  reuses the same IDs and cursor.
- Tests wait on claims/receipts and worker drains; none use real sleeps or polling.
- At runtime inspection there is one scheduler coordinator fiber regardless of
  automation count.

### Verification

```text
vp test run apps/server/src/scheduledAutomation/ScheduledAutomationOccurrence.test.ts \
  apps/server/src/scheduledAutomation/ScheduledAutomationScheduler.test.ts \
  apps/server/src/scheduledAutomation/ScheduledAutomationScheduler.restart.test.ts
vp run --filter t3 typecheck
```

### Exit gate

Current-workspace schedules may be exercised manually in development. Unattended
new-worktree rollout remains blocked on work package 6.

## Work package 5 — Truthful status and operational controls

### Purpose

Make current behavior explainable without adding a parallel run-history model.

### Implementation

- Join automation rows to projection shell state in the read service and return
  the derived operator-facing status and `nextScheduledFor`.
- Show starting/running/blocked/completed/failed/interrupted/skipped/thread-missing
  states, cursor, last error, coalesced count, and thread link in Settings.
- Use an automation-prefixed thread title so existing web/mobile/Slack directory
  rows are understandable without parsing IDs in each client.
- Signal scheduler re-evaluation immediately after enable/disable/update/delete;
  SQLite remains truth if the signal is lost.
- Add a readiness/health contribution: malformed stored definitions and scheduler
  startup failure are visible and do not crash unrelated chat/Slack operation.
- Document manual recovery: disable, inspect linked thread/worktree, correct the
  definition, retry-last when eligible, then re-enable.

### Acceptance criteria

- Read-service table tests derive each visible state from row + shell fixtures and
  never consult settlement for running/completed status.
- A thread moving from running to completed changes the next read/subscription
  view without requiring a lifecycle rewrite in the automation row.
- A missing last thread is shown as `thread-missing`, not silently rewritten to
  never-run or completed.
- Disabling takes effect before the next claim and leaves an in-flight thread
  untouched.
- Settings links use the existing environment/thread route builder and work over
  local, remote/relay, and tunnel connections because they remain same-origin
  client routes.
- An automation-created active shell fixture appears in the existing Slack App
  Home unsettled list with its automation title and deep link. No Slack steering
  or output relay is introduced.
- Mobile contract decoding tests accept the automation-created thread title/ID;
  no mobile management screen is added.
- Logs and errors contain automation/thread IDs but a test secret embedded in the
  prompt never appears.

### Verification

```text
vp test run apps/server/src/scheduledAutomation/ScheduledAutomationReadService.test.ts \
  apps/web/src/components/settings/AutomationsSettings.test.tsx \
  apps/slack/src/appHome.test.ts
vp run --filter t3 --filter @t3tools/web --filter @t3tools/slack typecheck
```

### Exit gate

An operator can identify why the latest occurrence ran, skipped, failed, or is
blocked and can reach the authoritative T3 thread.

## Work package 6 — Owned-worktree retention and fail-closed pruning

### Purpose

Bound disk use without risking a user's checkout or destroying unpreserved work.

### Implementation

- Add the server retention setting and a scoped, low-frequency housekeeping
  worker with an injected clock.
- Enumerate candidate automation threads from projection data and deterministic
  v1 identity, not only current automation rows, so deleted definitions remain
  cleanable.
- Prove all ownership markers, project existence, inactivity, retention age, and
  fresh clean Git status immediately before removal.
- Use `GitWorkflowService.removeWorktree({ force: false })`; never raw filesystem
  deletion and never `--force`.
- Do not delete the branch or checkpoint refs and do not clear the thread's
  `worktreePath`.
- Append deterministic `local-scheduled-automation.worktree.pruned` or
  `local-scheduled-automation.worktree.prune-blocked` activities. Avoid emitting
  the same blocked activity every housekeeping tick; key it by candidate and
  blocking reason.
- A pruned historical thread is not resumable in place. The UI/activity instructs
  the user to create a new thread/worktree from the retained branch.

### Acceptance criteria

- A real temporary Git integration test creates an automation worktree, advances
  the fake clock past retention, prunes it, then proves: `git worktree list` no
  longer contains the path; the directory is absent; the branch still exists;
  the T3 thread, messages, activities, and non-null `worktreePath` still exist.
- Table-driven safety tests refuse removal for each independently: unknown ID
  prefix/version, branch mismatch, path outside worktree root, path equal to the
  root, symlink/canonical escape, Git list mismatch, missing project, active
  session, pending approval, pending input, queued turn, running latest turn,
  recent activity, dirty tracked file, dirty untracked file, and Git status error.
- A completed-but-unsettled clean run older than retention is eligible.
- The remove call always has `force: false`; a mock asserting any force/raw-remove
  attempt fails the test.
- A dirty worktree gets one visible `prune-blocked` activity for that reason and
  remains registered with Git and present on disk.
- Retrying housekeeping after successful prune is idempotent and adds no duplicate
  activity or error.
- Changing the global retention setting affects old runs, including a run whose
  automation definition has been deleted.
- Housekeeping tests use a fake clock/trigger and worker drain, never wall-clock
  sleep.

### Verification

```text
vp test run apps/server/src/scheduledAutomation/ScheduledAutomationWorktreePruner.test.ts \
  apps/server/src/scheduledAutomation/ScheduledAutomationWorktreePruner.integration.test.ts \
  packages/contracts/src/settings.test.ts
vp run --filter t3 --filter @t3tools/contracts typecheck
```

### Exit gate

Unattended new-worktree schedules remain disabled until the real-Git integration
test and every fail-closed refusal fixture pass.

## Work package 7 — Integrated qualification, docs, and rollout

### Purpose

Prove the packages compose across restart and every applicable product surface,
then enable a deliberately small production rollout.

### Implementation

- Add one server integration scenario using temporary SQLite, a fake clock, fake
  provider, and real temporary Git repository: create disabled definition,
  enable, claim, restart at injected phase, reconcile, complete, schedule the next
  occurrence, then prune after retention.
- Add user documentation under `docs/user/automations.md`, contributor
  architecture under `docs/internals/`, and an operations runbook under
  `docs/operations/`.
- Document single-process ownership, timezone/misfire behavior, setup-script
  exclusion, current-workspace isolation warning, retention safety, manual retry,
  and what delete does not delete.
- Document the downstream namespace and future consolidation sequence: disable
  local scheduler, import through `ScheduledAutomationRepository`, verify
  definitions/cursors/thread links, enable the upstream scheduler, and retain the
  local v1 table read-only until cutover is confirmed.
- Roll out first with one disabled definition, then one read-only/current-workspace
  test, then one new-worktree automation with a long interval and observable
  prompt. Inspect its linked thread and pruning result before enabling more.

### Acceptance criteria

- The integrated scenario proves one row, one occurrence thread, one worktree,
  one initial message, and one provider turn across every injected restart point.
- A second due occurrence after the first is terminal starts a different
  deterministic thread even if the first is not settled.
- The same scenario with the first run active records `skipped-active` and creates
  no second thread.
- Web and desktop contracts, route, Settings navigation, and command-palette entry
  pass focused tests.
- Provider decision is explicit: no adapter-specific change is needed because
  automation uses the existing provider instance/model selection and bootstrap
  path; live capability validation rejects unsupported selections.
- Connection-mode decision is explicit: `scheduledAutomation.*` RPC/subscriptions
  use the existing WS session and therefore cover local, remote/relay, and tunnel
  without origin-specific URLs.
- Mobile decision is explicit and documented: execution threads remain visible;
  definition management is deferred.
- Slack decision is explicit and tested: active automation threads appear as
  ordinary deep-linked directory entries; no live hub behavior is added.
- Documentation states that setup scripts do not run for automation v1 and does
  not imply an exactly-once guarantee the server cannot prove.
- Internal documentation identifies `local_scheduled_automations_v1` as
  downstream-owned and explicitly prohibits dual-running local and future
  upstream schedulers during migration.
- No repo-wide check is required. Focused tests, affected-package typechecks, and
  formatting/lint for changed files pass.
- With explicit user permission, one integrated web-client pass demonstrates
  create/edit/enable/disable/retry/delete and captures evidence for any UI PR.

### Verification

```text
vp test run apps/server/src/scheduledAutomation/ScheduledAutomationLifecycle.integration.test.ts
vp run --filter @t3tools/contracts --filter @t3tools/client-runtime \
  --filter t3 --filter @t3tools/web --filter @t3tools/slack typecheck
vp fmt --check <changed files>
vp lint <changed files>
```

Use the repository's exact supported changed-file syntax when implementing; do
not replace the focused checks above with `vp check`, a repo-wide test run, or a
repo-wide typecheck.

### Exit gate

The first deliberately small rollout has produced inspectable thread, scheduler,
restart, and pruning evidence, and the shipped documentation matches those
observations. Only then may unattended new-worktree definitions be enabled more
broadly.

## Dependency sequence

```text
WP0 contracts/truth fixtures
  -> WP1 durable management
    -> WP2 management UI
    -> WP3 resumable bootstrap
      -> WP4 scheduler/reconciliation
        -> WP5 visibility/operations
          -> WP6 pruning safety
            -> WP7 integrated rollout
```

WP2 and WP3 may be developed in parallel on separate branches after WP1, but they
must be integrated in the sequence above. WP4 depends on WP3. WP6 depends on the
deterministic identity/path decisions in WP0 and the actual execution behavior in
WP4. WP7 is the only release gate.

## Stop/re-scope triggers

Stop the one-phase implementation and re-scope if any of these becomes required:

- multiple T3 server processes can schedule against the same SQLite file;
- every missed cron instant must execute after downtime;
- setup scripts must run exactly once across process/host crashes;
- history must survive automation deletion with per-run policy/outcome metadata
  not derivable from T3 threads;
- current-workspace automations require cross-automation or cross-process
  filesystem exclusion for the whole provider session;
- worktrees may be force-pruned while dirty;
- disabling must interrupt a running provider;
- mobile must create/edit definitions in v1.

Each trigger requires a materially different model: a lease/job ledger, durable
setup execution receipts, per-run rows, session-long workspace locks, preservation
workflow, cancellation orchestration, or a new client surface. None should be
smuggled into a later work package as a small extension.

## Definition of done

Automation v1 is done only when:

- all eight work-package exit gates pass in order;
- the integrated restart scenario proves idempotency from SQLite, command
  receipts, projection state, and live Git state;
- durable SQL, RPC, thread, activity, setting, and worktree identifiers use the
  scheduled-automation namespace; `Automations` remains only the user-facing
  label;
- unattended new-worktree execution remains off until pruning qualification
  passes;
- Web and desktop management are present, mobile and Slack decisions are tested
  and documented, and all provider/connection-mode decisions are explicit;
- user, internal, and operations documentation describe shipped behavior without
  promising run history, setup execution, distributed scheduling, or guaranteed
  retry behavior that v1 does not implement.
