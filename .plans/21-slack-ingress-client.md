# Slack Ingress Client and App Home

## Status

Planned. Product and boundary decisions are locked in
`docs/integrations/slack-jira-ingress-design.md`. This plan begins after that
design lock and covers the Slack implementation plus the bootstrap extraction
required by the broader ingress/automation design.

## Goal

Ship a stateless Slack sibling process that:

- starts a T3 conversation from a standard slash command or mention using the
  workspace project and its current checkout;
- offers a four-control custom setup for custom invocations and direct messages;
- never relays or steers an already-started T3 conversation from Slack;
- replies with a durable deep link to the T3 web client;
- publishes a concise team-wide directory in App Home;
- shares external-ingress resolution, idempotency, and T3 transport code with the
  future Jira client;
- runs against a renewable, narrowly scoped T3 service credential.

## Locked Product Behavior

### Standard start

- Standard `/t3` and ordinary mentions start immediately.
- Target the configured workspace project.
- Use `Current checkout`; do not create a T3 worktree.
- Resolve model selection from integration config and the project's
  `defaultModelSelection`.
- If no valid default can be resolved, fail with a configuration message and a
  custom-setup action rather than inventing a provider/model.

### Custom and DM setup

The setup has exactly four selectors:

1. Project
2. Workspace: `Current` or `New worktree`
3. Branch
4. Model / effort

Branch is always rendered:

- Current: the branch and its existing root-checkout or worktree location.
- New worktree: the base branch from which T3 creates the worktree.
- Non-repository projects render a disabled/no-repository branch value and allow
  only Current.

Workspace and Branch are coupled without adding a fifth control. Selecting a ref
whose `worktreePath` differs from the project `workspaceRoot` while in Current
continues in that exact worktree. A ref without a secondary path uses the root
checkout, switching it when necessary. Branch options carry `current` / `worktree`
badges, while the Workspace label remains Current. Selecting New worktree makes
Branch the base branch. The app re-lists refs on submission and uses the resolved
`worktreePath` as the target; it must not treat the branch name alone as the
identity of an existing worktree.

Model / effort is one flattened, grouped, searchable selector of valid
combinations. Build a ragged matrix from each model's own live capability
descriptors; never assume that models share an effort set. A model without an
effort capability contributes one default combination.

### Conversation boundary

- One explicit Slack invocation creates one T3 conversation.
- Delivery retries resolve to the same deterministic T3 IDs.
- Once started, the Slack origin is link-only.
- Ordinary follow-up Slack messages never dispatch a T3 turn.
- A mention inside an existing human Slack thread is identified by its own event
  ID/message timestamp, not by the surrounding thread root.

### App Home

- Content is team-wide and identical, although Slack publishes it per user.
- Publish a fresh view on every `app_home_opened`.
- Show a top-level T3 link.
- Fill capacity `X` with unsettled conversations first.
- Fill remaining capacity with the newest settled conversations.
- Filter the oldest settled conversations first.
- Omit archived conversations and preserve T3's effective lifecycle/visibility
  semantics.
- Link every row directly to its T3 conversation.

### Authorization and delivery

- No Slack-user/channel/team allowlist or quota in v1.
- T3 daemon credential is limited to `orchestration:read` and
  `orchestration:operate`.
- Cross-system delivery is idempotent and best-effort, not transactional.
- Reconcile ambiguous dispatch through T3 snapshots before reporting uncertainty.
- If verification is impossible, return a friendly message with the public T3
  base URL.

## Non-Goals

- No Slack steering, approvals, user-input relay, streamed output, settle actions,
  or live conversation mirroring.
- No Slack Agents View/agent-mode dependency.
- No read-only conversation modal in this workstream.
- No Jira implementation.
- No automation scheduler or automation UI.
- No per-user Slack preferences database.
- No durable Slack inbox/outbox.
- No branch creation UI in Slack v1.
- No Entra/OIDC work.

## Architecture

### Shared external-ingress runtime

Add `packages/integration-runtime` (final package name may follow repository naming
review) with no Slack/Jira dependencies. It owns:

- platform-neutral ingress request/result types;
- target resolution against live projects/providers;
- deterministic entity/command ID construction;
- HTTP snapshot and dispatch operations;
- authenticated WS RPC setup and reconnect;
- shell projection maintenance;
- branch/ref queries;
- deep-link construction;
- recovery classification (`created`, `resumed`, `already-started`,
  `unverified`).

The package consumes `@t3tools/contracts`. Reuse narrowly applicable
`packages/client-runtime` authorization/HTTP helpers where they do not require the
browser/mobile supervisor model; do not import web-only state or React code.

Slack and Jira use this external runtime. Server automations call the in-process
bootstrap service directly and must not route through HTTP/WS.

### Slack process

Add `apps/slack` as a workspace app using Bolt in Socket Mode.

Responsibilities:

- Slack manifest and scopes;
- Socket Mode lifecycle;
- slash command, mention, DM, action, modal, and App Home handlers;
- immediate Slack acknowledgement;
- four-control setup rendering;
- Slack-specific origin/correlation extraction;
- Slack Block Kit rendering and message updates;
- process health and credential reload.

Keep Slack SDK types and Block Kit builders out of the shared ingress package.

### Server bootstrap service

Extract the current `dispatchBootstrapTurnStart` workflow from
`apps/server/src/ws.ts` into an Effect service such as
`apps/server/src/orchestration/Services/ThreadBootstrapService.ts`.

The first extraction is behavior-preserving:

- thread create;
- optional worktree preparation;
- optional setup-script launch/activity recording;
- final turn start;
- existing error translation and cleanup;
- existing startup command serialization.

The WS dispatcher delegates to the service. The automation reactor can consume the
same service later. Before implementing this slice, read
`.repos/effect-smol/LLMS.md` and `docs/operations/effect-fn-checklist.md` as required
for server Effect work.

## T3 Transport and Authentication

Configuration distinguishes:

- internal T3 HTTP/WS URL used by the sibling process;
- public T3 URL used in Slack links;
- T3 bearer credential file;
- configured workspace ProjectId;
- optional integration-wide default ModelSelection;
- Slack App Home capacity `X`;
- Slack app and bot tokens.

Startup flow:

1. Load the T3 bearer credential from a root-owned file.
2. Validate the HTTP session/scopes.
3. Request a short-lived WS ticket.
4. Connect to `/ws`.
5. Call `server.getConfig` to obtain environment ID, providers, capabilities, and
   settings.
6. Start `orchestration.subscribeShell`.
7. Reconnect with a fresh WS ticket after disconnect.

Deep links use:

```text
{publicBaseUrl}/{environmentId}/{encodeURIComponent(threadId)}
```

Never build links from a hand-written thread-only path.

## Identity and Recovery

Define versioned, deterministic identifiers and cover them with snapshot tests.
The exact readable encoding may change before code review, but these inputs are
locked:

| Slack surface | Invocation identity |
| --- | --- |
| Slash command | Stable command invocation/envelope identity |
| Bot-owned DM/setup thread | Workspace + channel + root identity |
| Mention | Slack Events API event ID or mention message timestamp |

Derive:

- one ThreadId per invocation;
- one initial MessageId per invocation;
- phase CommandIds for create/start;
- Slack message metadata containing IDs only.

For workspace/current-checkout ingress:

1. `GET /api/orchestration/threads/:threadId`.
2. If absent, HTTP-dispatch deterministic `thread.create`.
3. If the deterministic initial MessageId is absent, HTTP-dispatch
   `thread.turn.start`.
4. If present, return the existing link.

For Current targeting the root checkout:

1. Validate the selected ref with `vcs.listRefs`.
2. Switch through `vcs.switchRef`, using the existing T3 failure semantics.
3. Create/start over HTTP as above.

For Current targeting an existing worktree:

1. Re-list refs and resolve the selected branch to a non-root `worktreePath`.
2. Reject a stale selection if the branch no longer identifies that worktree.
3. Create/start over HTTP with the existing `worktreePath`; do not switch the
   project root and do not create another worktree.

For New worktree:

1. Validate the selected base ref.
2. Generate the worktree branch with the shared T3 branch-name helper.
3. WS-dispatch `thread.turn.start` with `bootstrap.createThread`,
   `bootstrap.prepareWorktree`, and the normal setup-script policy.
4. Query the thread after an ambiguous response before reporting uncertainty.

The current WS bootstrap is not transactionally replay-safe across every partial
worktree failure. Keep that limitation explicit; do not claim HTTP-grade recovery
for the worktree path until the server workflow itself becomes phase-resumable.

## Target and Selector Projection

### Projects

Source from the shell snapshot. Validate selections again on submission so a
deleted/changed project cannot be dispatched from a stale Slack view.

### Workspace and branches

Use `vcs.listRefs` with query/pagination for the selected project's
`workspaceRoot`.

- `isRepo: false`: Current only; disabled branch placeholder.
- `isRepo: true`: Current and New worktree.
- Current defaults to the root checkout's current ref.
- Refs carry `current` / `worktree` badges. Selecting a worktree-backed ref while
  in Current retains its resolved path without changing the Workspace label.
- New worktree defaults to the repository default ref, falling back to the current
  ref, matching T3 web behavior.
- Inherit T3's new-worktrees-start-from-origin setting rather than adding a fifth
  Slack control.

Use Slack external/searchable options for branches so large repositories are not
materialized into one view payload. Keep Slack option values compact and
re-resolve the branch-to-worktree mapping from `vcs.listRefs` on submission rather
than embedding an absolute path in the view.

### Model / effort combinations

Source provider instances/models from `server.getConfig`:

- exclude disabled, unavailable, uninstalled, or unusable provider instances;
- preserve ProviderInstanceId as the routing key;
- enumerate each model;
- inspect only that model's effort-like capability descriptor;
- emit one option per valid effort value;
- emit one default option when no effort control exists;
- start from project/integration defaults and replace only the exposed effort
  selection so other model options retain their defaults.

Each Slack option value resolves to a complete `ModelSelection`; never trust a
display label as dispatch input.

## Slack Interaction Flow

Initial manifest/handler names:

- `/t3 <prompt>`: standard start;
- `/t3-custom <prompt>`: custom setup;
- ordinary app mention: standard start;
- explicit custom mention action/syntax: Configure button, then setup;
- DM message: setup flow.

Keep command/action identifiers centralized so the custom command spelling can
change without touching ingress logic.

For each invocation:

1. Acknowledge Slack immediately.
2. Post or update a visible `Starting…` state.
3. Resolve the deterministic identity and target.
4. Run the shared ingress operation.
5. Replace the starting state with:
   - `Open in T3 Code`;
   - a recoverable configuration/validation error; or
   - an unverified result plus the public T3 base URL.

Modal behavior:

- always render all four selectors;
- update the modal in place when Project, Workspace, or Model/Effort changes
  affect valid values;
- keep stable `block_id`/`action_id` values so Slack preserves input state;
- carry only origin/correlation identity in non-secret `private_metadata`;
- keep the initiating prompt in a visible text input so it can be reviewed or
  edited without hiding conversation content in metadata;
- revalidate all four selections on submit;
- do not create a T3 thread until submit succeeds.

## App Home Projection

Maintain one in-memory shell projection. Build a pure renderer input before
calling Slack APIs.

For capacity `X`:

```ts
const visibleUnsettled = unsettled.slice(0, X);
const remaining = X - visibleUnsettled.length;
const visibleSettled = settledNewestFirst.slice(0, remaining);
```

Use the same effective settled/snoozed helpers and ordering principles as the T3
clients. Keep block usage bounded:

- header/open-app link;
- one section per list when non-empty;
- one compact row per conversation;
- one truncation/footer link when needed.

On `app_home_opened`, publish for `event.user`. Cache rendered blocks by shell
revision/content hash. Keep only an in-memory set of users seen during the current
process for debounced live republishing; reopening always refreshes after restart.

## Credential Rotation and Deployment

Add a timer-driven rotation script:

1. Read a still-valid administrative rotator credential with `access:write` and
   the scopes it must delegate.
2. Create a narrow pairing credential for the Slack daemon.
3. Immediately exchange it for a bearer session.
4. Atomically replace the root-owned daemon credential file.
5. Restart/reload the Slack service.
6. Rotate the rotator's own credential before expiry.
7. Emit an actionable warning when rotation fails.

Run well before the 30-day session expiry (target day 20). Manual pairing is the
recovery path after missed expiry.

Deploy the Slack app as a sibling service with explicit PID/service ownership. Do
not start it against shared developer state during tests.

## Delivery Slices

### Slice 1: Shared runtime and standard ingress

- Scaffold `packages/integration-runtime` and `apps/slack`.
- Implement config decoding and health checks.
- Implement authenticated HTTP/WS T3 client.
- Implement deterministic IDs and HTTP recovery.
- Ship `/t3` and ordinary mention standard starts.
- Return deep links and friendly failures.

### Slice 2: Bootstrap extraction and custom setup

- Extract `ThreadBootstrapService` with focused behavior-parity tests.
- Implement live project/ref/provider projection.
- Implement four-control modal.
- Implement Current root-checkout branch switching.
- Implement existing-worktree discovery and continuation.
- Implement New worktree bootstrap.
- Add custom slash/mention and DM setup flows.

### Slice 3: App Home

- Implement shell projection/reconnect.
- Implement unsettled-first capacity logic.
- Implement per-user-on-open publication and in-memory live refresh.
- Add direct thread links and truncation footer.

### Slice 4: Operations

- Add credential rotation script/timer documentation.
- Add service environment/config documentation.
- Add health/readiness logging and expiry warnings.
- Document manual recovery and known best-effort delivery window.

## Tests

### Shared runtime

- deterministic IDs for slash, DM/root, mention, and phase commands;
- deep-link URL encoding;
- target default resolution and stale-target rejection;
- absent thread → create/start;
- existing thread without initial message → start only;
- existing thread with initial message → return existing link;
- ambiguous dispatch followed by successful snapshot reconciliation;
- unavailable T3 → unverified result;
- WS reconnect obtains a fresh ticket.

### Selector/model projection

- repository vs. non-repository workspace options;
- Current and New worktree branch semantics;
- Current routes a worktree-backed ref to its existing worktree;
- existing-worktree continuation resolves and revalidates the exact non-root
  `worktreePath`;
- stale branch-to-worktree mappings are rejected without creating a thread;
- branch query/pagination mapping;
- provider availability filtering;
- different effort sets on peer models;
- model without effort capability;
- preservation of non-effort defaults;
- complete `ModelSelection` output per option.

### Slack adapter

- immediate acknowledgement before T3 work;
- standard vs. custom routing;
- mention identity does not use the surrounding root;
- follow-up messages do not dispatch;
- modal state survives view updates;
- all selections are revalidated on submit;
- starting message transitions to success/error/unverified;
- metadata contains no prompt, tokens, or secrets.

### App Home

- unsettled rows always precede/displace settled rows;
- newest settled rows win remaining capacity;
- oldest settled rows filter first;
- no settled rows when unsettled reaches capacity;
- archived and T3-hidden lifecycle states follow client semantics;
- block count stays within Slack limits;
- identical content is published separately for each opening user.

### Server bootstrap extraction

- existing no-worktree bootstrap behavior is unchanged;
- worktree creation receives selected base branch and generated branch;
- setup-script activity behavior is unchanged;
- failure cleanup/error translation is unchanged;
- WS dispatch continues to serialize through startup.

Run only focused tests and typechecks for touched packages/files. Do not run the
repo-wide suite unless explicitly requested.

## Acceptance Criteria

- Standard slash/mention creates exactly one workspace/current-checkout T3
  conversation and returns a valid deep link.
- Custom/DM setup presents exactly four selectors.
- Branch is present in every workspace mode with the locked semantics.
- Model/Effort presents only valid per-model combinations.
- Current with a root ref, Current with an existing-worktree ref, and New worktree
  all succeed against a real test repository.
- Continuing on an existing worktree creates a new T3 conversation with that
  worktree's exact path and does not create or switch another checkout.
- Slack follow-ups cannot steer or add a T3 turn.
- Retries do not create duplicate T3 threads/messages.
- App Home shows the latest `X` conversations with unsettled-first capacity and
  oldest-settled-first filtering.
- Every App Home open gets a fresh per-user publication of the same team-wide
  view.
- Slack owns no durable domain state.
- The daemon uses only orchestration read/operate scopes.
- Credential rotation is documented, testable, and warns before expiry.
- Focused tests and typechecks pass.

## Known Accepted Limitations

- A process crash after Slack acknowledgement but before durable T3 dispatch or
  result posting can strand the Slack starting state.
- Full New worktree bootstrap does not yet have the same phase-by-phase replay
  guarantee as plain HTTP create/start.
- App Home users seen before a process restart are not proactively republished
  until they reopen.
- Cost controls are organizational rather than technical in v1.
