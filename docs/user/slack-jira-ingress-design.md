# Slack / Jira Ingress & Automations — Design Decisions

Status: **design locked, no code written yet** (as of 2026-07-29; Slack ingress,
custom setup, delivery posture, and App Home behavior locked 2026-07-31).
Owner: Jeroen. This document records decisions from the design conversation so future
sessions/agents don't re-litigate them or re-invent descoped features.

> **Read this first if you're an agent picking up this work.** The "Locked decisions"
> section is authoritative. Where a tempting extension was considered and rejected,
> that rejection is recorded inline with its rationale — treat those as decisions,
> not gaps. Do NOT build rejected extensions without re-opening the discussion with
> Jeroen.

---

## Context

We want to drive t3code (running on a Linux VM, served at e.g. `t3.deltablue.ai`)
from Slack and Jira: start agent conversations, see them listed, and follow a deep
link into the hosted t3code web UI for real interaction.

T3 upstream ships fast, so the overriding architectural constraint is:
**minimize modifications to upstream codepaths; prefer additive files and
client-boundary integrations.** (Rebase-risk ranking established below.)

---

## Locked decisions

### 1. Slack and Jira are STATELESS CLIENTS, not server features

They consume `packages/contracts` and the existing HTTP/WS API exactly like the web
and mobile clients do. **T3 remains the sole authoritative state — the integrations
own NO durable domain state (no shadow database).** Transient connection state
(Socket Mode session, caches) is fine; a client-owned mapping table is not — it
could disagree with T3's live provider/project catalog.

- Dispatch: WS `orchestration.dispatchCommand` (or HTTP, see #1a).
- Read/subscribe: `orchestration.subscribeShell` (sidebar-level state) and
  `orchestration.subscribeThread` (per-thread events) over `/ws`.
- Auth: pairing token → bearer/cookie session, same as any remote client.

Zero server-core modifications required for the client functionality itself.

### 1a. Idempotency and correlation WITHOUT a client database

Amended after review (2026-07-29) — replaces an earlier "link-state table" idea.
Verified mechanics:

- **Deterministic IDs**: `makeEntityId` is a branded trimmed-non-empty string with
  no format validation — a client MAY choose `ThreadId` / `MessageId` /
  `CommandId` deterministically. Slack bot-owned DM/setup roots can key from the
  root; a mention inside an existing human Slack thread keys from the specific
  mention event/message, NOT the surrounding thread root; Jira keys from
  site+issue+invocation. `MessageId`/`CommandId` derive from that stable invocation
  identity plus a phase suffix.
- **Command receipts**: re-dispatching a command whose `commandId` has an
  `"accepted"` receipt is deduped by the engine (returns the original sequence, no
  re-execution). T3's receipts + projections ARE the recovery ledger.
- **Restart/retry recovery**: query `GET /api/orchestration/threads/:threadId`
  (404 vs. full thread incl. `messages`) with the deterministic ID, then:
  no thread → create+start; thread without initial message → start the turn;
  message present → ingress already completed.
- **Correlation back to the origin platform** uses the platforms themselves:
  Slack ack messages carry the T3 link, the ThreadId in Block Kit action values,
  and [Slack message metadata](https://docs.slack.dev/messaging/message-metadata/)
  (retrievable via history APIs; not secret-safe — IDs only). Jira: the visible
  comment with the T3 link, optionally an
  [entity property](https://developer.atlassian.com/cloud/jira/platform/jira-entity-properties/)
  for machine-readable ThreadId.
- **Origin provenance**: v1 encodes the origin in the deterministic ThreadId (zero
  T3 changes); if origin becomes a first-class T3 concept, add a proper field to
  the thread contract then (verified: `thread.create`/`thread.created` currently
  have NO metadata field — title and client-chosen IDs are the only free-form
  strings).

**Caveat — bootstrap idempotency**: the full bootstrap workflow
(`thread.create` → worktree → setup script → turn start) exists ONLY in the WS
dispatcher (`dispatchBootstrapTurnStart`, `apps/server/src/ws.ts`); the HTTP
dispatch handler passes commands raw to the engine, so `bootstrap` is **silently
ignored over HTTP** and a `thread.turn.start` for a nonexistent thread fails. The
WS path also issues its own server-side `thread.create`, so a bootstrap that dies
mid-worktree-preparation is NOT replay-safe as one command — recovery means
inspecting thread state and resuming what's missing. **For workspace-project
threads (no worktree, see #6), plain `thread.create` + `thread.turn.start` over
HTTP is fully idempotent per command** — prefer that shape where possible.

**Resolution by trigger kind** (locked 2026-07-29):

- **External clients** (Slack/Jira sibling process): WS dispatch when full
  bootstrap is needed; plain HTTP commands for workspace-project threads.
- **Server-internal triggers** (automations, #9): do NOT go through any transport.
  Extract the bootstrap orchestration out of `ws.ts` into a shared service layer
  (e.g. `ThreadBootstrapService`) that both the WS dispatcher and the automation
  reactor call. The reactor has direct in-process access to
  `OrchestrationEngineService.dispatch`, `GitWorkflowService.createWorktree`, and
  `ProjectSetupScriptRunner` — no socket/RPC/auth round-trip. This extraction is a
  small mechanical diff to `ws.ts` (replace inline logic with the service call),
  zero behavior change, and plausibly upstreamable. Fallback if we want zero
  `ws.ts` churn: the reactor composes the same steps from those services directly
  (accepted risk: logic duplication/drift). For automations this is NECESSARY,
  not optional: ephemeral-agent runs against real repos want a worktree + setup
  script per run, which HTTP dispatch alone cannot produce.

### 1b. Per-user defaults: no private store

The earlier "per-Slack-DM stored defaults" phrase had no good owner and is amended.
Resolution order for project/harness/model/effort on thread start:

1. Trigger-side static config (integration-wide).
2. The T3 project's `defaultModelSelection`.
3. Previous selection inferred from the bot's last Slack message metadata in that
   DM/channel (Slack holds it, not us).
4. A modal asking the user when nothing applies.

If integration preferences later deserve a first-class home, that home is a T3
settings surface — never a private ingress database.

### 2. Slack is ingress + directory, NOT a 2-way live hub

The Slack surface is exactly three things:

1. **Thread start**: Slack message / slash command → immediate default start OR
   custom setup → `thread.turn.start` with `bootstrap.createThread` → reply with a
   deep link ("Follow on t3.deltablue.ai/.../{thread}").
2. **Thread overview in App Home**: a team-wide directory projected from
   `subscribeShell`, split into unsettled and settled conversations, with each row
   deep-linking out. App Home also becomes the place to view running automations
   later. Slice 3 temporarily omits server-explicit settled rows unless a pending
   approval or user-input blocker must remain visible.
3. **Deep links everywhere**: every Slack message the bot posts carries "Open in T3".

**Rejected extension — do not build:** making Slack a 2-way live client (steering
mid-turn, approval/question relays, streamed output, settle mirroring). This was
considered and deliberately rejected: it means rebuilding a parallel client-runtime
in Block Kit, and the hosted web UI has strictly better affordances (diffs,
checkpoints, approvals). Slack's job is to get you _to_ the conversation; all
interaction past thread-start happens in the web UI via deep link.

**Future (explicitly parked, not descoped):** read-only in-Slack conversation view —
a Slack modal (`views.open`) rendering the conversation read-only, Jira-issue-in-Slack
style. Cheap once App Home exists (same subscribe→render-BlockKit plumbing).
Steering still happens only via the deep link.

### 2a. Slack invocation modes and custom setup

There are two start modes:

- **Standard slash command / ordinary mention**: start immediately in the
  configured workspace project, in its current checkout/base available folder,
  with the configured or project-default model selection. No T3 worktree is
  created and no setup modal is shown. This is the common team-wide path for
  cross-repository questions and lightweight work.
- **Custom slash/mention entry point and direct-message setup**: collect the
  target before creating the T3 thread. A mention event cannot open a modal
  directly, so a custom mention may first post a Configure button; this is Slack
  transport UX, not durable ingress state.

The custom setup has exactly FOUR selectors:

1. **Project**
2. **Workspace** — `Current` or `New worktree`
3. **Branch** — always present; for Current, the branch and its existing checkout
   or worktree location; for New worktree, the base branch
4. **Model / effort** — one flattened selector containing only valid combinations
   from each live model's own capability descriptors

The fourth selector is deliberately a ragged Model × Effort matrix, flattened into
one Slack control. Models are NOT assumed to share an effort set. Models without
an effort control get one default entry. Other model options retain their T3
defaults in v1.

Project selection determines which workspace and branch targets are available.
Workspace and Branch are coupled controls: a branch ref whose `worktreePath`
points outside the project's root checkout represents an existing worktree.
With Workspace set to `Current`, selecting that ref continues in its exact
worktree path rather than trying to check the branch out in the project root. A
ref without a secondary worktree path targets the project's current checkout.
Branch options carry `current` / `worktree` badges so the location remains visible
without adding another Workspace option or changing its label. `New worktree`
makes Branch the base branch. The selected path is re-resolved from live ref data
on submission; branch name alone is not sufficient target identity. Workspace
selection changes the meaning of Branch, but never hides it. The initiating Slack
text is the prompt; it may be carried into or made editable in setup without
becoming a T3 turn before submission.

Once the T3 conversation has started, its Slack origin becomes link-only. Ordinary
follow-up Slack messages MUST NOT dispatch another T3 turn, steer the provider, or
relay conversation content. Retried delivery of the same invocation returns the
same T3 link. A new explicit invocation is a new conversation.

### 2b. Slack authorization and cost posture

v1 has NO per-Slack-user, channel, or team authorization layer beyond access to the
installed Slack app. The backing provider may be a shared cross-team account or
API-token-funded harness; all authorized Slack app users may invoke it. Cost
control is initially an organizational agreement/process concern. Add technical
allowlists, quotas, or role checks only if that proves insufficient.

The T3 service credential remains least-privilege (`orchestration:read` and
`orchestration:operate`) even though Slack-user authorization is intentionally
open.

### 2c. Slack delivery guarantee

Delivery is **idempotent and best-effort**, not transactionally guaranteed across
Slack and T3:

- Acknowledge Slack promptly, then use deterministic T3 IDs and thread snapshots to
  reconcile absent / partially-started / already-started invocations.
- Slash commands and bot-owned DM/setup roots correlate naturally to one T3
  conversation. Mentions inside an existing Slack thread correlate by the specific
  mention event/message identity, not the parent thread root.
- If dispatch times out, inspect T3 before reporting uncertainty. If T3 itself is
  unavailable and the result cannot be verified, reply with a friendly
  "couldn't verify" message plus the T3 base URL.
- A process crash after Slack acknowledgement but before dispatch/result posting
  can still strand a visible starting state because the integration owns no
  durable inbox/outbox. This is an accepted v1 limitation; T3 remains available as
  the recovery directory. Re-open the no-durable-client-state decision if
  guaranteed delivery becomes a requirement.

### 2d. Slack App Home directory

Slack publishes App Home per user, but every user receives the SAME team-wide T3
directory. On every `app_home_opened`, render and publish a fresh view for that
event's user ID. An in-memory set of users opened during the current process may
receive debounced live republishing; it is safe to lose that set on restart.

The view contains:

1. A top-level link to the T3 web app.
2. **Unsettled conversations** first, because they are ongoing.
3. **Settled conversations** second, filling only the remaining row budget.
4. A link to T3 when additional conversations were filtered out.

For configured capacity `X`:

```text
visible = unsettled.slice(0, X)
remaining = X - visible.length
visible += settledNewestFirst.slice(0, remaining)
```

Therefore unsettled rows always displace settled rows, and the oldest settled rows
are filtered first. If unsettled alone reaches `X`, no settled rows are shown.
Archived conversations are omitted. Every displayed conversation deep-links to
T3; Slack is a concise directory, not a complete archive.

Slack allows 100 blocks in Home and modal views. The setup modal is far below that
limit. The parked read-only conversation modal will need truncation/pagination if
implemented later.

### 3. Slack's Agents View (agent mode): plain bot v1; NOT needed for the read-only view

Slack's Agents feature (`assistant:write`, `agent_view` manifest, thinking status,
streaming, suggested prompts) only exists in the app's DM surface (the **Messages
tab of App Home** — that tab IS the DM surface); channels get none of it.
Decision:

- **v1: plain bot everywhere** (chat.postMessage + buttons + mentions + modals).
  The dispatch/correlation core is identical either way.
- **Agents View is NOT required for the parked read-only conversation view** —
  Slack modals (`views.open` from a button/link action) are plain bot machinery,
  available to any app. There is no lock-in argument for enabling Agents View
  early; it can be flipped on later without re-architecting.
- **Agents View remains a future product option** — reconsider ONLY if a live DM
  agent experience (status indicator, streaming, suggested prompts) is ever
  wanted. As long as Slack stays ingress+directory, it buys little.
- Paid-plan/guest caveats are irrelevant (team has a paid workspace; sandbox
  program is only for people without one).

### 4. Harness (provider instance) is chosen BEFORE thread creation

Verified in code: once a thread has a live session it is **bound to that driver** —
`ProviderCommandReactor.ensureSessionForThread` rejects cross-driver switches
("Thread is bound to driver X and cannot switch to Y"); even model-only changes can
be rejected when the provider sets `requiresNewThreadForModelChange`. Within a
driver, model/effort changes work via `thread.meta.update`.

Therefore: project + provider instance + model + effort are all selected at
`bootstrap.createThread` time. Defaults resolve per the stateless chain in #1b
(static config → project `defaultModelSelection` → prior bot-message metadata →
modal) — there is no per-user client-side store. Effort is real and per-harness:
`ModelSelection.options` (array of `{id, value}`); Claude exposes `effort`
(low→max, prompt-injected ultrathink) + `fastMode`; Codex/Cursor expose
`reasoningEffort`. (Provider capability claims verified against upstream HEAD in
this repo; re-verify after rebases.)

### 5. Mid-turn messages are steers; there is no turn queue

Verified: the decider does zero blocking on `thread.turn.start` — orchestration
neither queues nor rejects concurrent starts (no rejection for running turns,
pending approvals, or pending user-input). What a mid-turn message THEN does is
**adapter-specific** (e.g. Claude's adapter injects it as a steer into the live
agent loop; other harnesses differ — do not generalize). `hasQueuedTurnStart` only
blocks settle/snooze. (Background only; steering from Slack is descoped per #2.)

### 6. There is a "workspace" project spanning all cloned repos

- A project whose `workspaceRoot` is NOT a git repo works fine for thread create +
  turn start + agent execution (verified: decider does no git validation;
  `repositoryIdentity` resolves lazily to `null`; VCS status/checkpoints/diffs/PR
  features degrade gracefully to absent).
- Worktrees are optional at every layer — omit `prepareWorktree` and the thread runs
  directly in `workspaceRoot`.
- **Jira ingress targets only the workspace project.** Standard Slack slash
  commands/mentions also target it in Current checkout mode. Slack custom/DM setup
  exposes project, Current/New worktree, branch, and Model/Effort knobs per #2a.
  An existing worktree is selected through its worktree-backed branch.
- **Steering rule for workspace threads**: when real work spans repos, the AGENT
  creates branch→worktree per repo it touches (instructed via a workspace-level
  CLAUDE.md/AGENTS.md). T3-level worktree management stays per-repo-project.
- Origin is tracked via deterministic ThreadIds / platform-side metadata (see #1a),
  NOT a client-owned link-state table.

### 7. Jira context: inject the key, not the payload

The trigger prompt carries the issue identifier (+ the triggering comment snippet,
if any) and the agent fetches issue details/history live via the Atlassian MCP.
Don't stream full issue payloads in — they rot, waste tokens, and the agent needs
MCP access anyway to act (comment/transition/label).

### 7a. Jira ingress is EXPLICIT, never ambient

Jira must NOT start T3 work from generic issue-created / issue-updated /
comment-added events. The v1 entry point is an explicitly invoked Jira app action:

- A Forge `jira:issueAction` (e.g. "Start T3 Code") in the issue menu → opens a
  modal for an optional instruction/config override → submission invokes the
  stateless Jira ingress client.
  ([Forge issue action docs](https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-issue-action/))
- Ingress payload carries at least: `cloudId`, issue ID/key, initiating actor, and
  a unique **invocation ID**.
- Each explicit invocation creates ONE new T3 conversation; Jira receives a
  visible comment with the T3 link; an issue/comment entity property may carry the
  ThreadId for machine-readable correlation (no secrets — properties are mutable
  and visible).
- **Deterministic Jira ThreadId = `cloudId + issueId + invocationId`** — NOT
  issue-only. One persistent conversation per issue is a different product choice;
  only adopt it deliberately later.
- **Future (parked, not v1):** Atlassian's
  [Rovo Agent Connector](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-agent-connector/)
  (assignment, mentions, chat) — currently EAP and requires an A2A server. A
  possible presentation/ingress upgrade, not the production foundation.

Note: whether Jira stays a symmetric ingress trigger or becomes an
automation/loop candidate remains under consideration (open question 2).

### 8. MCP servers configure the HARNESSES, not t3code

Verified: T3 has no MCP settings surface. Adapters inject only T3's internal
preview MCP. External MCPs (Jira/Atlassian, Aikido, Daytona) are configured per
provider instance via the harness CLI home (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) and
are inherited by every thread on that instance.

### 9. Automations live in the SERVER + WEBAPP as ONE workstream

No scheduling exists upstream (verified: only internal housekeeping pollers).
Automations cannot be a pure client (triggers must originate work durably), so
this is additive server code plus its webapp configuration UI, designed and built
together. **Status: explicitly flagged for scoping/refinement at implementation
start** — the webapp surface (placement, CRUD flow, contract commands for
automation management) is intentionally undesigned beyond the notes below.

- v1 automation = **user prompt + project + provider/effort + cron target**, plus
  explicit fields (or locked global defaults) for **runtimeMode, interactionMode,
  worktree policy, and setup-script policy** — the scheduler must not inherit
  ambiguous execution semantics.
- Shape: `Automation` entity + commands in contracts (new file mirroring
  orchestration.ts), `AutomationScheduler` layer (Effect `Schedule`, house style),
  reactor dispatching via the extracted bootstrap service (#1a "Resolution by
  trigger kind"). No decider changes.
- **The durable state is ONE table, one row per automation** — no job queue, no
  run-history table, no retry state. Sketch:
  `{ id, name, prompt, projectId, modelSelection, runtimeMode, interactionMode,
worktreePolicy, setupScriptPolicy, schedule (cron), enabled, lastScheduledFor,
lastThreadId, lastOutcome }`. The T3 thread IS the execution record (messages,
  activities, turn state all live in the event store); the row only adjudicates
  schedule occurrences and links to what they produced. Loops/graphs later grow
  FROM this row (add chaining/kind fields), not around it.
- **Overlap policy (v1): skip a scheduled occurrence while the automation's
  previous thread is still active.** "Active" = ANY of: starting/running provider
  session; pending approval or user input; queued/unadopted turn start; latest
  turn not in a terminal state. **Do NOT use settlement as the active test** — a
  completed-but-unsettled thread must not block the next run. On skip: advance the
  schedule cursor (so restart reconciliation doesn't repeatedly retry), record
  `lastOutcome: "skipped-active"` for App Home visibility, and create NO thread.
- **`lastScheduledFor`** (NOT `lastRunAt`): the scheduled occurrence already
  adjudicated — skip-vs-run is decided against it, and it decouples restart
  catch-up from wall-clock execution time.
- **Deterministic ThreadId per occurrence: `automationId + scheduledFor`** — T3
  projections and command receipts provide restart/idempotency recovery without a
  separate run table (same mechanics as #1a).
- **Loops** = automation chaining off its previous thread (`lastThreadId` →
  context seed). **Graphs** = decision trees between loops — explicitly later.
- App Home surfaces running automations (they're just threads; origin is visible
  via the deterministic ThreadId convention per #1a until/unless a contract field
  exists; `lastOutcome` gives skip visibility).
- **Unlike Slack/Jira ingress, automations DO own durable state** (the
  `automations` table above) — that state is T3-server-owned, never client-owned.

### 10. Task/agent taxonomy (the 2×2)

|                     | Short-horizon task    | Long-horizon task            |
| ------------------- | --------------------- | ---------------------------- |
| **Ephemeral agent** | dep bump, triage      | nightly migration, then gone |
| **Durable agent**   | standing debug thread | multi-day feature build      |

Durability lives in the THREAD (event log in SQLite), not the checkout — the
worktree is a scratchpad. Ephemeral agents get worktrees, cleaned up by RETENTION,
not by lifecycle event (see #10a). Long-horizon = persistent thread + snooze/wake
(the `ThreadSnoozeCommand` contract already reserves event-based wake conditions).

### 10a. Worktree retention and pruning (replaces "cleanup on settle/complete")

Settlement/completion NEVER directly triggers worktree deletion. Policy:

- Automation-created ephemeral worktrees are **retained for a configurable number
  of days**, then pruned by a periodic housekeeping process.
- Prune ONLY when ALL hold: the worktree is explicitly identified as T3-owned
  automation worktree; its thread has no active session, pending approval/input,
  queued turn, or incomplete latest turn; no relevant activity within the
  retention window; the path resolves inside the configured T3 worktree area; the
  git worktree is clean (or a configured preservation policy proves work is safely
  committed/pushed).
- Mechanics: use `git worktree remove`, never raw recursive deletion; never
  force-remove a dirty worktree (skip, record `prune-blocked`); do NOT auto-delete
  the branch; preserve the T3 thread, messages, activities, and checkpoint refs;
  append a visible "Worktree pruned" activity.
- **Do NOT clear `worktreePath` to null after pruning** — T3 would then fall back
  to the project workspace root, and a resumed historical thread could modify the
  primary checkout. A pruned run is resumed via a NEW thread/worktree created from
  the retained branch.

### 11. Daytona: PINNED — undecided, do not design around it

Open questions Jeroen wants answered by a concrete use case first: sandbox per repo?
per stack (go, php7, php8, node → ad-hoc dev containers)? repo transport (scp?)?
Working assumptions: NO t3 server inside sandboxes (sandbox is a tool the agent
wields via Daytona MCP, not an environment); with strict worktree cleanup,
sandboxes aren't really necessary for the current design; sandboxing earns its keep
as a _trust boundary for ingress_ (e.g. dependency-update automation running
`npm install && npm test` on ticket-chosen code), if anywhere.

### 12. Auth: anonymous portal identity in development; edge OIDC for production

- **Development**: the public reverse proxy injects a shared T3 bearer credential with only
  `orchestration:read` and `orchestration:operate`. Browsers see no T3 pairing or
  login prompt, while T3's existing session and RPC scope checks remain active.
  The T3 listener stays on loopback/private networking; only the HTTPS proxy is
  public. This requires ZERO server changes and is suitable for the dev-app phase,
  but it is not the production access policy.
- **Slack sibling process**: use an internal loopback HTTP/WS URL and its own narrow
  T3 bearer credential for API traffic, plus the public proxy URL for deep links.
  Do not reuse the portal credential: independent credentials keep rotation and
  revocation boundaries small.
- **Credential rotation**: T3 bearer sessions currently expire after 30 days.
  Rotate the Slack and portal credentials before expiry, atomically replace their
  secret files, reload/reconnect, verify, then revoke the previous sessions.
  Manual pairing and narrow token exchange over loopback is the recovery path if a
  timer misses the expiry window. This is credential rotation, not a refresh-token
  flow.
- **Production graduation gate — Entra ID (OIDC)**: enforce OIDC at the same
  reverse-proxy boundary before graduating the Slack app and conversation portal
  from development to production. Continue injecting the narrow shared portal
  credential after successful login.
  No T3, Slack, deep-link, or WebSocket changes are required. The gateway can audit
  the employee identity; T3 deliberately continues to see one team portal
  principal.
- **Only if requirements change**: native T3 OIDC or proxy-trusted user headers are
  needed only if T3 itself must distinguish users for authorization/auditing.
  Thread-scoped capabilities are optional and only justified if a link recipient
  must not see other environment conversations; UI filtering alone is not an
  authorization boundary.
- Deployment and rotation steps are in
  [Deploying the Slack conversation portal](slack-conversation-portal-deployment.md).

### 13. The server serves the webapp itself

Verified: `apps/server` serves the production SPA at `/` (bundled client build →
monorepo `apps/web/dist` fallback, SPA fallback to index.html). One process, one
port, UI+API+WS on one origin — deep links from Slack/Jira are trivially correct.
Two processes only in dev (302 → Vite).

### 14. Shared ingress surface across Slack / Jira / cron

All triggers funnel into one pipeline: receive → resolve target (project,
provider/effort, prompt template; trigger-side config) → dispatch
`thread.turn.start` (+bootstrap) → post deep link back to origin. Slack and Jira
are symmetric trigger adapters; cron is the third adapter (via the automation
scheduler, #9).

---

## Rebase-risk ranking (established, guides all implementation choices)

1. **Slack/Jira clients** — zero risk: stateless external processes consuming
   contracts + API, no durable state of their own.
2. **Automations** — mostly additive files; the one deliberate upstream touch is
   extracting the bootstrap workflow from `ws.ts` into a shared
   `ThreadBootstrapService` (mechanical, behavior-preserving, plausibly
   upstreamable — see #1a).
3. **Anonymous portal + edge OIDC** — proxy-only deployment; zero T3 server-core
   changes.
4. **Optional native identity/thread authorization** — modifies T3 auth and read
   boundaries; deliberately deferred unless per-user or per-thread isolation is
   required.

## Boundary summary (the one-paragraph version)

- **Slack/Jira**: stateless ingress + projection clients; T3 is the sole state
  authority; correlation via deterministic IDs and platform-native metadata.
- **Automations**: T3-owned entities with durable server-side state; clients
  trigger and display them.
- **Slack App Home**: read-only projection of the T3 shell (+ automation state
  once it exists).
- **No shadow database anywhere outside the t3code server.**

---

## Verified codebase facts (for future agents; re-verify before relying on)

- No Slack integration exists anywhere in the repo (only a comment URL in
  `CursorAcpExtension.ts`); no `@slack/*` deps.
- Server is Effect-TS; HTTP router in `apps/server/src/http.ts`; WS RPC in
  `apps/server/src/ws.ts`; orchestration is event-sourced CQRS:
  `OrchestrationEngineService.dispatch` → events (SQLite) → projections.
- Key contracts: `packages/contracts/src/orchestration.ts` (ThreadTurnStartCommand,
  bootstrap ~L660-706), `auth.ts` (closed unions ~L50, L69), `model.ts`
  (ProviderOptionSelections ~L90).
- `makeEntityId` = branded trimmed-non-empty string, no format validation →
  client-chosen deterministic IDs are valid (`packages/contracts/src/baseSchemas.ts`).
- Command receipts dedupe re-dispatched accepted `commandId`s
  (`OrchestrationEngine.ts` + `OrchestrationCommandReceipts`).
- Bootstrap workflow (`thread.create`→worktree→setup→turn) exists ONLY in the WS
  dispatcher; HTTP dispatch passes commands raw and ignores `bootstrap`.
- `thread.create`/`thread.created` have NO metadata/origin field.
- `GET /api/orchestration/threads/:threadId` → `OrchestrationThreadDetailSnapshot`
  incl. messages; 404 `thread_not_found` when absent.
- Slack Agents platform: Agents feature in app settings grants `assistant:write`;
  manifest `agent_view`; events `app_home_opened`, `app_context_changed`,
  `message.im`; status via `assistant.threads.setStatus`; streaming via
  `chat.startStream/appendStream/stopStream`; Socket Mode available (no public URL
  needed). Docs: https://docs.slack.dev/ai/developing-agents/

---

## Delivery shape (implementation order, updated 2026-08-03)

This is an implementation dependency order, not the chapter order of this design.
The automation sequence is the fixed next workstream. Its later follow-ons may be
reordered as implementation evidence changes their cost or value. Jira remains the
default last feature because its product shape is unresolved and automations or
loops may absorb much of its value.

0. **Slack ingress foundation — implemented.** Slices 1–4 cover shared ingress,
   standard and custom starts, App Home, and operations. Updating and exercising
   the installed dev Slack app is rollout work, not the next feature-development
   slice.
1. **Automation definition and management.** Scope the intentionally open product
   details, then build the automation contracts, single-row durable entity,
   persistence, CRUD commands, and webapp management UI as one vertical
   workstream. An automation must explicitly define its prompt, project,
   provider/effort, cron target, runtime and interaction modes, worktree policy,
   and setup-script policy before it can be enabled.
2. **Reliable automation execution foundation.** Harden the already-extracted
   `ThreadBootstrapService` so new-worktree execution is phase-resumable. A retry
   after interruption must inspect the existing thread, worktree, setup activity,
   and command receipts, then continue only the missing phase instead of creating
   duplicate worktrees, rerunning completed setup, or stranding the turn. Prefer
   deriving progress from existing durable state over adding another workflow
   store.
3. **Automation scheduler and occurrence reconciliation.** Schedule enabled
   automations in-process, adjudicate each occurrence through `lastScheduledFor`,
   use deterministic occurrence ThreadIds, recover safely after restart, and
   implement the locked `skipped-active` overlap policy without a job queue or run
   table. The T3 thread remains the execution record.
4. **Automation worktree retention and pruning.** Implement the safety policy in
   #10a before unattended ephemeral-worktree schedules are considered ready:
   retention windows, ownership and activity checks, safe path validation, clean
   worktree enforcement, `git worktree remove`, visible `prune-blocked` outcomes,
   and preserved thread/branch/checkpoint history.
5. **Automation visibility and operational controls.** Surface running, completed,
   failed, and skipped outcomes with links to their threads in the webapp; make
   enable/disable and failure recovery clear; and let active automation threads
   appear naturally in Slack App Home. Web and desktop are required, with an
   explicit mobile-surface decision before completion.
6. **Automation loops.** Once ordinary scheduled runs are reliable, allow an
   automation occurrence to seed itself from `lastThreadId`. Define stop,
   disable, failure, and context-boundary behavior before considering graphs or
   decision trees.
7. **Remaining Slack product improvements.** Restore the intended newest-settled
   App Home tail as a small completion patch, then consider the parked read-only
   conversation modal. Slack remains ingress + directory; steering, approvals,
   and live output stay in T3.
8. **Conditional infrastructure.** Add Daytona or stronger isolation, durable
   Slack inbox/outbox delivery, or native per-user T3 authorization only when a
   concrete requirement justifies them.
9. **Jira integration — last by default.** When it is eventually picked up, first
   decide whether Jira should remain an explicit symmetric ingress action or
   become an automation/loop trigger; do not implement an adapter before that
   product decision.

**Production graduation is a gate, not backlog item 10.** The dev Slack app and
anonymous shared-credential portal may be used while the work above proceeds, but
they must not graduate to production until Entra ID/OIDC is enforced at the proxy
boundary. That work can move earlier whenever production graduation becomes the
next objective; it does not otherwise block dev feature implementation.

Slack implementation details and acceptance criteria live in
`.plans/21-slack-ingress-client.md`; this document remains the authoritative
product/design boundary.

---

## Open questions (updated 2026-07-31)

Slack module placement, invocation modes, setup controls, delivery posture, App
Home layout, authorization posture, and credential rotation are RESOLVED above.
Remaining questions belong to later workstreams:

1. **Jira integration shape**: symmetric ingress trigger vs. re-scoped as an
   automation/loop candidate (Jeroen reconsidering). DEFERRED — answer when the
   Jira workstream is picked up; refine as its first step (see Delivery shape).
2. **Daytona**: DEFERRED — pinned per #11; not part of anything we're delivering
   right now.
3. **Automation webapp UI + engine scoping**: DEFERRED — folded into one workstream
   (#9); placement, CRUD flow, and contract commands intentionally undesigned —
   scope at implementation start.
4. **Workspace-project ergonomics**: prompt template / CLAUDE.md content for the
   branch→worktree-per-repo steering rule. Still open.
