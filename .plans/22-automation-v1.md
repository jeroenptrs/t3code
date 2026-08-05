# Automation v1 — Durable Scheduled Runs

## Status

Implementation in progress. Work package 0 is implemented and verified: the
scheduled-automation contracts, deterministic occurrence fixtures, five-field
cron semantics, shared queued-turn truth, active-run predicate, and optional
bootstrap target-path wire shape with fail-closed pre-WP3 handling now exist.
Work package 1 is implemented and verified after review hardening: the namespaced
v1 migration, guarded SQLite repository and CAS operations, durable management
service, snapshot and committed-row-change subscription, WS RPC surface, and
compound read/operate authorization now exist.
WP2's web/desktop management vertical is implemented and verified: the shared
settings route, navigation/search and command-palette entry, environment-wide
subscribed list, capability-backed create/edit form, branch refresh/invalidation,
safety disclosures, CAS conflict review, and enable/disable/retry/abandon/delete
controls are present. WP3's shared `ThreadBootstrapService` is installed in the
server runtime and is phase-resumable for deterministic automation callers; its
crash-point, worktree-identity, failure-retention, WS-compatibility, and setup-skip
acceptance suites pass. WP4's latest-only occurrence planner, durable claim and
reconciliation path, retry handoff, and single scoped scheduler coordinator are
implemented and verified with an injected clock, restart fixtures, cooperative
large-misfire counting, conflated change wakes, and bounded failure backoff.
WP5's table-driven operator status, projection-driven subscription refresh,
operational Settings detail, scheduler/definition health, automation-prefixed
thread titles, cross-client visibility, and recovery documentation are
implemented and verified.

The expanded WP0 acceptance and regression suites and affected
contract/server/client-runtime typechecks pass. A further review identified
case-folded ownership-key and alternate-ingress concerns; both were reproduced,
fixed, and regression-tested. The WP0 exit gate has passed.
The WP1 migration, repository, service, RPC, authenticated-WS authorization,
restart, and boundary acceptance tests pass with the affected contract/server
typechecks. The WP1 exit gate has passed; no scheduler loop or scheduled execution
was installed at that gate. WP4 now installs the scheduler after command readiness.

WP1 also made one additive post-WP0 contract adjustment explicit:
`ScheduledAutomationInternalError` is part of the RPC error union so persistence
and read-service failures fail closed without being misreported as validation or
not-found results. WP1's preliminary row-plus-shell views are now completed by
WP5's table-driven status truth and projection-change-driven subscription
refresh.

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

`ScheduledAutomationId` is a 1–64 character ASCII identifier beginning with an
alphanumeric character and containing only letters, digits, `.`, `_`, and `-`.
That bound keeps its lowercase-hex ownership key within Git-ref and filesystem
component limits. Lowercase hex is deliberate: ownership keys must remain distinct
after case folding on common Windows and macOS filesystems.

`ModelSelection`, `RuntimeMode`, and `ProviderInteractionMode` reuse the existing
orchestration contracts. Provider/model/options are validated against the live
server catalog when a definition is enabled and again when an occurrence is
claimed. Failed outcomes carry durable `code`, `detail`, and `retryable` truth;
legacy rows without `retryable` decode fail-closed as non-retryable. Operators
can disable and abandon a rejected occurrence; an already abandoned occurrence
remains final without reviving either deterministic identity.

A definition may remain stored while its project or provider is
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
- `scheduledAutomation.failed.abandon`
- `scheduledAutomation.delete`

Update, enable/disable, retry, abandon, and delete carry `expectedRevision`. The
repository uses a compare-and-swap update and returns a typed conflict containing
the current row when another client has changed it. Create is disabled by
default. Abandon requires a disabled failed row, marks its occurrence
non-retryable, and preserves its thread/worktree artifacts while restoring
definition editability. Delete is allowed only while disabled and deletes only
the automation row; its T3 threads, branches, and worktrees remain governed by
normal retention.

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
that tuple. Identity derivation rejects non-absolute timestamps and canonicalizes
equivalent instant spellings before encoding them.

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

The newest occurrence is selected from the forward `Cron.next` sequence. Do not
use `Cron.prev` or raw local-time matching: they are not inverse operations around
daylight-saving gaps and repeated hours. Library failures, including impossible
calendar expressions, remain in the typed error channel.

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
new run. A durably rejected phase is explicitly non-retryable. The operator must
disable and abandon that failed occurrence before correcting occurrence-resource
fields; the next schedule then receives new occurrence IDs.

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
`coalescedCount` is the number of eligible earlier occurrences discarded by
`latest-only`, so it is zero when exactly one occurrence is due.

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
| Was an orchestration bootstrap phase completed? | accepted deterministic command receipt with the expected aggregate plus matching projected thread state |
| Was deterministic Git preparation completed? | fresh live ref/worktree snapshot where the exact branch and canonical path agree |
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
- Extend the existing bootstrap prepare-worktree contract with an optional target
  path. Existing web/Slack clients omit it, and client-facing ingress always
  rejects it. From WP3 onward, a trusted in-process automation adapter validates
  and consumes it inside the deterministic ownership namespace; WP0 only locks
  the wire shape and the fail-closed interim behavior.
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
  policy. Management command drafts preserve invalid cron/timezone strings until
  server validation returns stable `schedule.cron` / `schedule.timeZone` fields.
- Snapshot tests prove the same `(automationId, scheduledFor)` always yields the
  same ThreadId, MessageId, phase CommandIds, branch, and worktree path, while two
  different occurrences yield different values. Equivalent spellings of one UTC
  instant yield identical identities, and the maximum valid automation ID stays
  within Git-ref and filesystem component limits. Distinct valid automation IDs
  remain distinct after filesystem case folding.
- ID snapshots contain neither prompt text nor model/provider credentials.
- Cron fixtures cover UTC, a non-UTC zone, a daylight-saving gap, a repeated
  daylight-saving hour, cursor-present restart cases, multiple missed occurrences
  under `latest-only`, and impossible calendar expressions returning typed errors
  rather than defects.
- The active predicate's table covers every session status, all four latest-turn
  states, pending approval, pending input, a fresh queued start, an expired queued
  start, missing thread, settled thread, and completed-but-unsettled thread.
- The completed-but-unsettled fixture is inactive, proving settlement is not used
  as overlap truth.
- Client/HTTP normalization and `ThreadBootstrapService` both reject an explicit
  bootstrap `targetPath` until WP3 validates and consumes it; tests prove the
  rejection happens before attachment writes or orchestration dispatch.

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
  repository. Claims are accepted only for an enabled row with an activation
  boundary, a strictly newer cursor, and a matching outcome occurrence.
- Add a `ScheduledAutomationService` that validates live
  project/provider/ref capability, handles management commands, and publishes
  in-memory changes after commit.
- Add WS RPC methods for command dispatch, list/get, and a snapshot-plus-change
  subscription. Read methods require `orchestration:read`; mutation methods
  require both `orchestration:read` and `orchestration:operate` because mutation
  responses and conflicts contain the full definition.
- Until WP4 installs durable reconciliation, `retry-last` on a failed row returns
  a typed unavailable/invalid-state result and changes no durable state. It must
  never report a successful no-op.
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
- Occurrence claim atomically rejects disabled rows, null activation boundaries,
  duplicate/backward cursors, mismatched outcome occurrences, and a concurrent
  disable that wins the revision CAS.
- Enabling rejects a missing/deleted project, unavailable provider instance,
  unsupported model option, invalid base ref, non-Git new-worktree target, and any
  setup policy other than `skip`.
- Disabling succeeds even when dependencies have become unavailable.
- Delete is rejected while enabled. A successful delete leaves orchestration
  events, projections, branches, and worktree directories untouched.
- Subscription tests receive an initial SQLite-backed snapshot and committed
  upsert/remove changes from management and direct repository claims; a fresh
  subscription after process restart reconstructs the same snapshot without
  relying on PubSub history. Projection-only view refresh remains WP5 scope.
- Authorization tests prove through the authenticated WS boundary that read-only
  and operate-only sessions cannot mutate, and that operate-only sessions cannot
  recover prompt/configuration data from mutation responses or typed conflicts.
- SQLite schema inspection finds `local_scheduled_automations_v1`, does not find a
  locally created plain `automations` table, and finds no local automation
  run/job/history table.
- A repository-boundary test proves the WP1 service consumes only
  `ScheduledAutomationRepository` operations and does not embed the SQL table
  name. WP4 adds the equivalent scheduler proof when the scheduler exists.
- A seeded failed row proves pre-WP4 `retry-last` rejects without changing its
  revision, outcome, cursor, or timestamps.

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
  are revalidated by the server when enabling and when editing an already-enabled
  definition. Every save still validates cron, timezone, and the definition
  schema; disabled definitions may preserve temporarily unavailable dependencies.
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
- An open editor preserves unsaved fields and conflict state across project and
  provider snapshot refreshes. Live descriptor changes may normalize the current
  model options, but must not reset unrelated draft fields.
- The model selector only emits combinations present in that model's live
  capability descriptors; it does not assume a common effort set. Provider
  eligibility matches server validation: warning is eligible, while uninstalled,
  unavailable, disabled, and error providers are not.
- A disabled definition may change non-capability fields while preserving an
  unchanged project/model/worktree selection that is temporarily unavailable.
- Selecting a different project clears an invalid branch and model default rather
  than submitting stale values.
- Entering new-worktree mode and changing project refresh the searchable,
  paginated branch source. Query failures, non-Git projects, policy errors, and
  base-ref errors are visible at the workspace controls.
- Invalid cron/timezone errors returned by the server are rendered on the
  corresponding controls; the browser's preview is advisory only. Cron, timezone,
  and schema validation occur on every save. Live project/provider/model/options
  and base-ref validation occur when enabling and when editing an already-enabled
  definition.
- A stale-revision response never retries the write automatically and visibly
  presents the current server definition. A create collision locks the server
  row ID, and every subsequent update derives both ID and revision from that row.
- Disable leaves the linked running thread unchanged. Delete requires a disabled
  row and explicitly says it does not delete prior threads/worktrees. Row actions
  remain disabled while their command is pending.
- The subscription remains pending until its first snapshot and uses one stable
  creation-time/ID order for snapshots and later change events.
- The route and command-palette action work in the web build and the Electron
  wrapper without Electron-specific RPC.
- Settings navigation/search tests include Automations, and generated route-tree
  changes are committed if the router generator updates them.
- Mobile decision is recorded: no automation management route in v1; existing
  thread list/detail behavior remains the mobile execution view.

### Verification

```text
vp test run apps/web/src/components/settings/AutomationsSettings.test.tsx \
  apps/web/src/components/settings/AutomationsSettings.interaction.test.tsx \
  apps/web/src/components/settings/settingsSearch.test.ts \
  apps/web/src/commands/scheduledAutomationCommands.test.ts \
  apps/web/src/state/scheduledAutomations.test.ts \
  apps/server/src/scheduledAutomation/ScheduledAutomationService.test.ts
vp run --filter @t3tools/contracts --filter @t3tools/client-runtime \
  --filter @t3tools/web --filter t3 typecheck
```

### Exit gate

The UI is contract-complete, but production rollout still keeps automations
disabled because bootstrap recovery and scheduling have not passed.

### Implementation record

WP2 passed its focused acceptance suite and affected
contracts/server/client-runtime/web typechecks. Rendered interaction tests drive
every create/edit definition field through the real dialog and assert the command
callback payload. The acceptance suite also covers capability-stream rerenders
without draft loss,
warning/uninstalled eligibility, unavailable selections on disabled definitions,
model switching with model-specific options, branch search/pagination/refresh and
error states, field-anchored server errors, conflict-state preservation and
identity locking without automatic retry, and disabled/delete/pending safety
behavior. Logic, state, and service tests additionally lock project-change
invalidation, the shared provider-eligibility predicate, exact save-versus-enable
live-validation timing, stable snapshot/change ordering, no pre-snapshot empty
emission, settings discovery, and command-palette routing. The generated route
tree contains `/settings/automations`.
Web and Electron use this same route and WS boundary without Electron-specific
RPC. Mobile intentionally has no management route in v1; its existing shared
thread list/detail remains the execution view when later work packages begin
creating automation threads.

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
- Before each orchestration phase, require both its accepted deterministic
  command receipt and matching projection detail. Either source without the
  other is a typed conflict; rejected or wrong-aggregate receipts fail closed.
- For deterministic new-worktree bootstraps, pass an explicit automation path to
  Git. Read a fresh local-ref snapshot before any fetch or add. Reuse only when
  the exact branch and canonical path form one live worktree; create only when
  neither exists. Branch-only, path-only, mismatched, and pruned states fail
  closed.
- Reserve the `t3sa:v1` command/message namespace and client-side ThreadId
  minting at orchestration ingress. Ordinary commands may address an existing
  automation ThreadId so users can follow up, approve, answer, interrupt, stop,
  archive, or delete it. Trusted automation paths are additionally checked as
  strict descendants of the configured automation worktree root.
- Freeze execution-field edits while an occurrence is `starting`. A corrected
  failed retry may update title/prompt/model/runtime/interaction through
  revision-keyed reconciliation commands. Its project, worktree policy, and
  setup policy remain immutable until that failed occurrence is abandoned. An
  operator may explicitly abandon a disabled automation's failed occurrence,
  preserving artifacts while making those fields editable for future
  occurrences.
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
- Exact worktree recovery succeeds without fetching origin, including while the
  remote is unavailable. Every identity scan requests fresh Git state.
- Branch-only, path-only, mismatched, and WP6-pruned states fail closed and
  neither adopt, recreate, nor remove a worktree.
- A final-turn dispatch timeout reconciles through receipt/message truth and does
  not send a second provider turn.
- Projection-only and receipt-only fixtures for create, metadata, and turn-start
  fail closed. Rejected and wrong-aggregate receipts also fail closed; message
  and same-project metadata collisions are not adopted.
- A conclusive failure retains the partial thread and appends one deterministic
  bootstrap-failed activity stamped at observed failure time. Consecutive
  failures do not duplicate the activity.
- An interactive retry with retained worktree metadata is adjudicated before any
  Git side effect and cannot leak a newly named worktree.
- A current-workspace concurrency fixture uses a barrier to force two dispatches
  past the same initial reads, then proves receipt dedupe accepts one create.
  One integration case also crosses the real SQLite
  event/projection/receipt transaction boundary.
- Starting execution edits are rejected. A failed same-occurrence correction
  reconciles the supported mutable thread fields and prompt without duplicating
  thread, worktree, or initial message; occurrence resource fields stay fixed
  until an explicit abandon. Receipt-rejected occurrences cannot retry and can
  be disabled/abandoned without deleting their artifacts.
- Client normalization and RPC tests prove existing automation threads remain
  operable while client attempts to mint their reserved ThreadIds fail.
- Re-enable tests prove the read view and shared planner use the later activation
  boundary and cursor, excluding disabled-period occurrences from display and
  coalescing, while the repository rejects a direct disabled-period claim; WP4
  must use the same helper when selecting claims.
- Failed outcomes durably decode retryability. Legacy
  `bootstrap.phase-rejected` and `occurrence.abandoned` rows fail closed as
  non-retryable in contracts, service dispatch, and Settings; abandonment
  remains available without hiding artifact retention or CAS conflicts.
- Focused `ThreadBootstrapService` fixtures prove switch-ref, origin-fetch,
  worktree, setup-launch/failure, and no-worktree behavior. Server RPC cases
  separately prove authenticated orchestration ingress, retained failure state,
  and address-but-do-not-mint automation identity enforcement.
- Scheduled-automation service tests prove `setupScriptPolicy: skip` produces no
  call to `ProjectSetupScriptRunner`.

### Verification

```text
vp test run apps/server/src/orchestration/Services/ThreadBootstrapService.test.ts \
  apps/server/src/orchestration/Normalizer.test.ts \
  apps/server/src/server.test.ts \
  apps/server/src/scheduledAutomation/ScheduledAutomationBootstrap.test.ts \
  apps/server/src/scheduledAutomation/ScheduledAutomationService.test.ts
vp run --filter t3 typecheck
```

Run only the named bootstrap cases from `server.test.ts` if the test runner
supports a name filter; do not turn this work package into a repo-wide test run.

### Exit gate

The same deterministic bootstrap can be resumed after every durable phase and no
test observes a duplicate thread, worktree, message, or turn.

### Implementation record

WP3 passed its focused acceptance suite and the affected server typecheck. The
runtime now constructs one shared `ThreadBootstrapService`; WS sessions and the
trusted scheduled-automation bootstrap boundary consume that instance. Durable
thread-create, metadata-update, turn-start, and bootstrap-failure identities are
derived from the caller's start `CommandId`. A phase is complete only when its
accepted receipt has the expected thread aggregate and its projected state
matches. Projection-only, receipt-only, rejected, and mismatched provenance fail
closed. A focused integration case proves recovery across the real SQLite
event/projection/receipt transaction boundary.

Failure-injection coverage stops after thread creation, Git worktree creation,
metadata acceptance, and turn-start acceptance, then replays the same bootstrap
and observes one thread, one live deterministic worktree, one initial message,
and one accepted turn start. Additional cases prove exact branch/path reuse,
offline origin recovery, fresh-ref scans, refusal of branch-only/path-only,
mismatched, externally pruned, and metadata-conflict states, retained partial
state, one deterministic secret-safe failure activity across consecutive
failures, and no cleanup deletion. Interactive retained-worktree retries are
adjudicated before Git mutation. Focused `ThreadBootstrapService` cases continue
to cover switch-ref, origin fetch, worktree, setup launch/failure, and
no-worktree behavior; the relevant server RPC cases cover ingress and retained
failure state. The automation adapter always emits `runSetupScript: false`; its test
composes the real bootstrap service and a dying runner. Client ingress rejects
reserved command/message IDs and attempts to mint automation ThreadIds, while
allowing normal interaction with existing automation threads. Explicit target
paths and reconciliation revisions remain trusted-only.

While `starting`, execution fields are frozen so reconciliation cannot mix a
claim-time thread with a later definition. For a corrected failed retry,
name/prompt/model/runtime/interaction changes use revision-keyed reconciliation;
project/worktree/setup policy changes are rejected until the failed occurrence
is abandoned. A disabled failed occurrence can be explicitly abandoned;
this retains its artifacts, permanently rejects retry for that occurrence, and
restores definition editability for future schedules. Rejected phase errors carry
`code = bootstrap.phase-rejected` and `retryable = false` so WP4 can persist the
same classification without parsing prose. The automation adapter classifies
every other failure as well: configuration/identity invariants are explicitly
non-retryable, temporarily unavailable projects and unclassified Git/bootstrap
failures are retryable, and no scheduler handoff must infer disposition from an
error message.

Failed outcomes now persist `retryable`; legacy JSON without the field decodes
fail-closed as non-retryable, while abandonment writes `retryable = false`.
Service and Settings retry eligibility consume that durable truth rather than
maintaining error-code blacklists. The read service and occurrence planner share
the later-of-`enabledAt`/`lastScheduledFor` planning boundary, so a re-enabled
definition does not display or coalesce an occurrence from its disabled interval.
Settings also provides the disabled-failed-only abandonment action with confirmation, retained
artifact disclosure, revision-bound CAS handling, and pending-state gating; WP5
owns the same behavior as an explicit acceptance requirement.

The final re-review WP3 sweep passed 123 focused contract, service, adapter,
identity, normalizer, provider-reactor, and web logic tests across eight suites,
plus 12 Settings interaction tests. Five
behavior-relevant server RPC cases passed; the broader nine-case name-filtered
selection also includes authentication/bootstrap setup cases and is not the
proof for switch-ref or no-worktree behavior.
Contracts/server/client-runtime/web/Slack typechecks, targeted lint/formatting,
and `git diff --check` are clean. The only intentionally retained v1 tradeoff is
the fresh paginated local-ref scan: the Git boundary has no worktree-only query,
and enumerating all local refs is required to prove that no differently named
branch owns the deterministic path.

## Work package 4 — Occurrence planner, durable claim, and scheduler

### Purpose

Start eligible automations at the right instant and reconcile crashes without a
job queue.

### Implementation

- Add a pure occurrence planner around Effect Cron and an injected clock.
- Use `scheduledAutomationPlanningBoundary` everywhere planning occurs: the
  later of `enabledAt` and `lastScheduledFor` is the exclusive boundary for
  displayed, claimed, and coalesced occurrences.
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
- Persist `OrchestrationDispatchCommandError.code` and `retryable` into the
  failed outcome. Retry eligibility consumes `retryable`, never a client/server
  code blacklist. Reject retry for non-retryable outcomes;
  `occurrence.abandoned` is the explicit supersession path.
- Query the deterministic `phaseCommandIds.startTurn` receipt as the accepted
  start oracle. No receipt is written under the root `bootstrapCommandId`;
  `phaseCommandIds.prepareWorktree` is reserved because Git has no orchestration
  command, while `recordFailure` identifies the failure-activity command.
- Log/measure claims, starts, skips, failures, reconciliation, and clock/misfire
  decisions with IDs and status only; never log prompts.

### Acceptance criteria

- With a fake clock, an enabled definition starts exactly once at a due instant;
  repeated ticks and duplicate definition-change signals do not change the row or
  dispatch again.
- Disabled definitions never claim. Enabling sets a durable activation boundary
  and waits for the first cron instant after it; re-enabling never replays the
  disabled interval in displayed, claimed, or coalesced occurrences.
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

### Implementation record

WP4 installs one scoped `ScheduledAutomationScheduler` after migrations,
projection/reactor startup, and command readiness. The coordinator attaches to
committed repository changes before its first read, reconciles all durable
`starting` rows before evaluating later occurrences, then waits on either the
nearest forward-cron instant or a committed in-memory change signal. Every wake
re-reads SQLite and the injected clock. Per-automation semaphores serialize
retry, reconciliation, and due evaluation; the repository revision/CAS remains
the final claim arbiter.

The pure occurrence plan uses `scheduledAutomationPlanningBoundary`, selects the
latest due occurrence from forward Effect Cron truth, and records the exact
discarded count. A constant-time UTC every-minute path handles the common case;
general cron/timezone counting reuses one parsed Cron and cooperatively yields
after bounded batches. Non-UTC 10,000-misfire coverage proves those yield points
without relying on wall-clock timing. Claim writes `starting` or
`skipped-active`, cursor, deterministic ThreadId, outcome, timestamp, and revision
atomically before any bootstrap side effect. The shared active-run predicate
controls every skip and retains the previous ThreadId.

Startup and explicit retry share the same reconciliation function. It checks the
deterministic `phaseCommandIds.startTurn` receipt and matching projected initial
message, otherwise delegates to the phase-resumable bootstrap service. Accepted
starts finalize without another side effect; typed bootstrap failures preserve
their stable code and retryability with prompt-redacted, bounded detail.
`retry-last` now moves the same occurrence back to `starting` through a revision
CAS and reuses its cursor, thread, message, and phase IDs. Live definition
validation was extracted so management enablement and claim-time execution share
the same project/provider/model/Git truth.

The coordinator converts repository changes to a size-one edge signal, so
duplicate management changes and claim/start notifications cause one follow-up
evaluation rather than one full scan per notification. Per-row failures impose
a fake-clock-driven exponential retry delay (capped at one minute), while a new
committed change can still wake immediately. Timer waits are also capped at one
minute for wall-clock correction and suspend recovery. Disabled durable
`starting` rows remain eligible for reconciliation, and keyed semaphores are
removed after their final waiter exits.

The WP4 occurrence, scheduler, and restart suites cover 1/10/10,000 due instants,
duplicate evaluations and committed definition signals, a 24-automation
self-notification batch, committed-change and timer wakes, persistent receipt
failure backoff, all active-run signals, durable skip truth, failure
bounds/redaction/retryability, explicit retry, restart before claim, a
pre-bootstrap `starting` restart, and accepted-start receipt reconciliation.
The production launcher and readiness gate have focused tests proving one launch
after command readiness, and a repository-boundary source test now includes the
scheduler and shared validation module.
Repository, management-service, bootstrap, startup-readiness, and focused server
regressions plus the server typecheck, targeted lint/format, and diff hygiene pass.
No browser pass applies to this server-only work package. Unattended
new-worktree rollout remains gated on WP6 as specified above.

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
- Document manual recovery: disable, inspect the linked thread/worktree, and use
  `retry-last` only for retryable failures. For rejected phases or resource
  corrections, abandon the failed occurrence first, correct the definition, and
  re-enable; retained artifacts remain available for inspection.
- Add an **Abandon last occurrence** Settings row action, gated to disabled,
  failed, non-abandoned rows. Require confirmation with an explicit retained
  thread/branch/worktree disclosure, carry the visible revision for CAS conflict
  handling, and disable the action while its command is pending.

### Acceptance criteria

- Read-service table tests derive each visible state from row + shell fixtures and
  never consult settlement for running/completed status.
- A thread moving from running to completed changes the next read/subscription
  view without requiring a lifecycle rewrite in the automation row.
- Automation-created threads retain their explicit `Automation:` title after the
  first provider turn; automatic first-turn title generation is not requested.
- A missing last thread is shown as `thread-missing`, not silently rewritten to
  never-run or completed.
- A linked thread whose latest turn failed shows its session error even when the
  durable occurrence outcome remains `started`.
- Disabling takes effect before the next claim and leaves an in-flight thread
  untouched.
- Subscription invalidations ignore streaming assistant deltas, conflate bursts,
  suppress unchanged views, and serialize repository/projection refreshes so a
  delayed refresh cannot resurrect a deleted definition.
- Malformed stored definitions degrade health without preventing valid
  definitions from being claimed and scheduled.
- Settings offers abandonment only for a disabled failed occurrence, discloses
  retained artifacts before confirmation, sends
  `scheduledAutomation.failed.abandon` with the visible revision, surfaces CAS
  conflicts without auto-retry, and prevents duplicate submission while pending.
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
vp test run packages/contracts/src/scheduledAutomation.test.ts \
  apps/server/src/persistence/Migrations/036_LocalScheduledAutomationsV1.test.ts \
  apps/server/src/scheduledAutomation/ScheduledAutomationOccurrence.test.ts \
  apps/server/src/scheduledAutomation/ScheduledAutomationRepository.test.ts \
  apps/server/src/scheduledAutomation/ScheduledAutomationBootstrap.test.ts \
  apps/server/src/scheduledAutomation/ScheduledAutomationScheduler.test.ts \
  apps/server/src/scheduledAutomation/ScheduledAutomationScheduler.restart.test.ts \
  apps/server/src/scheduledAutomation/ScheduledAutomationReadService.test.ts \
  apps/server/src/scheduledAutomation/ScheduledAutomationService.test.ts \
  apps/server/src/scheduledAutomation/scheduledAutomationRpc.test.ts \
  apps/server/src/serverRuntimeStartup.test.ts \
  apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts \
  apps/server/src/relay/AgentAwarenessRelay.test.ts \
  apps/web/src/commands/scheduledAutomationCommands.test.ts \
  apps/web/src/components/settings/AutomationsSettings.test.tsx \
  apps/web/src/components/settings/AutomationsSettings.interaction.test.tsx \
  apps/web/src/state/scheduledAutomations.test.ts \
  apps/slack/src/appHome.test.ts \
  apps/mobile/src/features/threads/automationThreadContract.test.ts \
  --silent=passed-only --reporter=dot
vp run --filter @t3tools/contracts --filter t3 --filter @t3tools/web \
  --filter @t3tools/slack --filter @t3tools/mobile typecheck
```

### Exit gate

An operator can identify why the latest occurrence ran, skipped, failed, or is
blocked and can reach the authoritative T3 thread.

### Implementation record

WP5 centralizes operator-facing state derivation in a table-tested server helper.
Durable failed and skipped adjudications retain precedence; starting/started
occurrences join against live shell truth for starting, running, blocked,
completed, failed, interrupted, and thread-missing states. Settlement is absent
from this derivation. Scheduled-automation subscriptions acquire orchestration
domain-event, repository, and scheduler-health subscriptions before their
initial read. A single serialized invalidation worker filters streaming deltas,
conflates bursts, rereads current truth, discards superseded reads, and emits
only changed views, so projection refreshes cannot resurrect deleted rows.

Settings now presents current status, next occurrence, durable cursor, last
outcome and coalesced count, typed failure code/detail/retryability, and the
ordinary same-origin environment/thread link. The existing disabled-only abandon
control remains revision-bound, conflict-visible, artifact-explicit, and guarded
against pending duplicate submission. Automation threads are created with an
`Automation:` title prefix, so existing web, mobile, and Slack shell consumers
show meaningful directory rows without parsing deterministic IDs.

The scheduler publishes scoped starting/running/failed health and isolates a
startup defect from unrelated server operation. Repository inspection returns
valid definitions while reporting a secret-safe malformed-row count; both the
scheduler and read service use that inspection so malformed neighbors do not
stop valid occurrences. Settings surfaces either degraded condition. Health
additions decode with a pre-WP5 default for list/snapshot compatibility and use
the existing snapshot stream variant for forward compatibility. The user
recovery guide documents disable, inspect, retry-only-when-retryable, and
abandon/correct/re-enable flows, including retained thread, branch, and worktree
artifacts.

The exact focused/regression command above passes 211 contract, migration,
repository, read-service, bootstrap, scheduler/restart, RPC, startup, reactor,
relay, web state/Settings, Slack App Home, and mobile contract tests across 19
suites. Affected contracts, server, web, Slack, and mobile typechecks pass;
targeted formatting and diff hygiene are clean. No
browser pass was run because this task did not include permission for computer
use.

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
