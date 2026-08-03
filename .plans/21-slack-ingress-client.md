# Slack Ingress Client and App Home

## Status

Slices 1–4 are implemented. Product and boundary decisions are locked in
`docs/integrations/slack-jira-ingress-design.md`.
This plan begins after that design lock and covers the Slack implementation plus
the bootstrap extraction required by the broader ingress/automation design.

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
- Publish a fresh view on every Home-tab `app_home_opened`; ignore Messages-tab
  opens.
- Show a top-level T3 link.
- Show conversations from every project in the environment.
- Order unsettled conversations newest-created-first, matching the inbox-based
  T3 sidebar.
- Omit archived and effectively snoozed conversations.
- **Temporary Slice 3 scope change:** omit server-explicit settled conversations
  unless a pending approval or user-input blocker must remain visible. The intended
  later behavior remains an unsettled-first list that fills remaining capacity
  with the newest settled conversations and filters the oldest settled conversations
  first.
- Render as many rows as Slack's App Home Block Kit block limit permits; there
  is no operator-configured row limit.
- Link every row directly to its T3 conversation.
- When rows are truncated, link `View all` to the main environment URL.

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
{publicBaseUrl}/{encodeURIComponent(environmentId)}/{encodeURIComponent(threadId)}
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

Maintain one sequence-aware in-memory shell projection that resumes
`orchestration.subscribeShell` after reconnect. Build a pure renderer input
before calling Slack APIs.

For Slice 3, select conversations from every project; omit archived and
effectively snoozed conversations plus server-explicit settled conversations
without pending approval or user-input blockers; then sort the remaining work
newest-created-first with deterministic ID ties. This settled-row omission is a
temporary scope reduction, not a replacement for the intended future
unsettled-first plus settled-tail design. Slack does not apply a separate
auto-settle policy.

Keep block usage within Slack's 100-block Home-tab limit:

- header/open-app link;
- one compact row per conversation;
- reserve a footer block before selecting rows when truncation is required;
- link the footer to `{publicBaseUrl}/{encodeURIComponent(environmentId)}`.

On Home-tab `app_home_opened`, publish for `event.user`; ignore Messages-tab opens.
Cache rendered blocks by shell revision/content hash. Serialize publications per
user and coalesce live updates onto the latest snapshot so an older Slack request
cannot finish last and strand a stale view. Keep only an in-memory set of users
seen during the current process for debounced live republishing; reopening always
refreshes after restart.
Arm a timer for the earliest snooze wake because timer-based wakes do not emit a
shell event.

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

Slice 1 establishes the reusable external-ingress boundary first, then proves it
with the smallest complete Slack adapter. Slack-specific code translates a Slack
invocation into a platform-neutral request and renders the result. The shared
runtime owns every decision and side effect from target resolution through T3
recovery and deep-link construction.

```text
Slack slash command / mention
        |
        v
Slack adapter: acknowledge, normalize origin, render status/result
        |
        v
packages/integration-runtime
  resolve target -> derive IDs -> inspect T3 -> create/start -> reconcile -> link
        |
        v
T3 HTTP/WS APIs
```

At the end of this slice, `/t3 <prompt>` and an ordinary app mention each start
exactly one conversation in the configured project's current checkout and return
a durable T3 deep link. The same invocation delivered again returns the same
conversation. No Slack SDK type crosses into the shared package.

#### Slice 1 boundaries

Included:

- the platform-neutral request/result model and standard-ingress operation;
- renewable authenticated HTTP and WS transport primitives usable by later
  Slack, Jira, custom-setup, and App Home work;
- live resolution of the configured project and a valid default model selection;
- deterministic invocation, entity, message, and command identifiers;
- idempotent HTTP create/start and snapshot-based recovery;
- Socket Mode process lifecycle, `/t3`, and ordinary mention handling;
- visible starting, success, configuration-error, and unverified Slack states;
- configuration decoding, startup validation, readiness, and safe logging.

Deferred:

- selectors, ref queries, branch switching, existing-worktree continuation, and
  New worktree bootstrap;
- `ThreadBootstrapService` extraction;
- custom slash/mention actions and direct-message setup;
- long-lived shell projection and App Home publication;
- credential issuance/rotation automation and deployment unit files.

The shared package may define extension points needed by those later slices, but
Slice 1 does not pre-build their branch, modal, projection, or rendering logic.

#### Work package 1: lock the ingress contract

Add platform-neutral types in `packages/integration-runtime` for:

- `IngressInvocation`: integration kind, versioned stable invocation identity,
  prompt, and display-safe origin context;
- `StandardIngressTarget`: configured `ProjectId` plus an optional integration
  `ModelSelection` override;
- `IngressRequest`: invocation, target, and request timestamp;
- `IngressResult`: `created`, `resumed`, `already-started`, or `unverified`, with
  the deterministic `ThreadId` and deep link when known;
- typed configuration/validation failures that an adapter can safely present to
  a user without exposing credentials or internal error detail.

The shared request contains no Slack channel, block, modal, or SDK types. Origin
fields needed only to post a Slack response stay in `apps/slack`; only the stable
identity and platform-neutral provenance enter the runtime.

Before implementation, lock and snapshot the readable, versioned identifier
encoding. Its inputs are:

- Slack team/workspace identity;
- surface kind (`slash` or `mention`);
- Slack's stable delivery/invocation identity;
- phase suffix for thread, initial message, create command, and start command.

The Slack spike for this work package must verify which Socket Mode envelope or
payload field remains stable across slash-command redelivery. Do not substitute
`trigger_id`, receipt time, or a generated UUID. If Slack supplies no suitable
stable slash identity, stop and revise the locked no-durable-state recovery design
before implementing dispatch.

Implementation evidence (2026-07-31): Socket Mode redelivery assigns the
transport acknowledgement its own `envelope_id`, while Bolt passes the original
slash-command payload through as the command body. Slack defines `response_url`
as part of that invocation payload and redelivers the same payload; unlike the
short-lived `trigger_id`, it therefore identifies the slash invocation across an
envelope retry. Slice 1 hashes the complete `response_url` into the versioned
identity, so its secret token never appears in a T3 identifier. This decision is
covered by a fixture asserting stable IDs for the same response URL and different
IDs for different response URLs. References: [Socket Mode envelopes](https://docs.slack.dev/apis/events-api/using-socket-mode/)
and [slash-command payloads](https://docs.slack.dev/interactivity/implementing-slash-commands/).

Review exit:

- the public package API can describe Slack and a future Jira adapter without a
  Slack/Jira dependency;
- deterministic ID fixtures are reviewed and versioned;
- the slash-command retry identity is evidenced against the actual Bolt payload.

#### Work package 2: build the T3 transport boundary

Implement a small transport interface in the shared package and a production
implementation using existing contracts:

- read the bearer credential from the configured file for each new authenticated
  session so a replaced credential can be picked up without code changes;
- call authenticated HTTP endpoints for the shell snapshot, thread snapshot, and
  orchestration dispatch;
- request a short-lived WS ticket and connect to `/ws`;
- call `server.getConfig` for environment identity and live provider
  capabilities;
- obtain a fresh WS ticket for every reconnect rather than reusing an expired or
  consumed ticket;
- classify authentication, authorization, transport, validation, not-found, and
  ambiguous dispatch failures without leaking response bodies or tokens.

Slice 1 does not maintain `orchestration.subscribeShell`. It reads
`GET /api/orchestration/shell` when resolving a standard invocation. The WS
connection supplies `server.getConfig` and establishes the reconnecting transport
needed by later slices. Slice 3 adds the long-lived shell subscription and
projection.

Keep the orchestration operation dependent on an injectable transport interface
so recovery behavior is tested without Slack or a live server. Reuse narrowly
applicable authorization/RPC code from `packages/client-runtime` only where it
does not pull in its supervisor, browser storage, or client state model.

Review exit:

- the transport surface contains only operations required by ingress;
- HTTP and WS URLs are derived from the internal T3 base URL, while links use only
  the separately configured public URL;
- reconnect demonstrably requests a new WS ticket;
- the package has no React, browser storage, or Slack dependency.

#### Work package 3: resolve a standard target

For every invocation, resolve against fresh T3 data rather than cached Slack
state:

1. Fetch the shell snapshot and find the configured `ProjectId`.
2. Reject a missing project. The shell contract proves that the project is
   registered and supplies its `workspaceRoot`; it does not prove that the path
   currently exists or is accessible.
3. Load `server.getConfig` and validate live provider instances/models.
4. Prefer the integration-wide `ModelSelection` when configured; otherwise use
   the project's `defaultModelSelection`.
5. Validate the complete selection against the matching enabled, installed, and
   usable provider instance and model capability data.
6. If neither default is valid, return a configuration failure. The Slack adapter
   may mention that custom setup is coming, but Slice 1 does not render or link a
   non-existent custom action.

The resolved target is always:

- the configured project;
- `Current checkout`;
- `worktreePath: null`, which delegates workspace resolution to T3's existing
  project-root resolver;
- `branch: null`; Slice 1 does not make a `vcs.listRefs` call merely to annotate a
  current-checkout thread;
- `runtimeMode: "full-access"` and `interactionMode: "default"`, matching T3's
  new-thread defaults;
- no branch switch, worktree creation, or setup-script bootstrap.

Build the initial thread title and turn `titleSeed` with the existing T3 client
rule: trim the prompt and pass it through `@t3tools/shared/String`'s `truncate`
helper (50 characters plus `...` when truncated). Empty prompts are rejected by
the Slack adapter before target resolution.

Review exit:

- a stale configured project cannot dispatch;
- a stale or unavailable model default cannot dispatch;
- no provider/model is invented as a fallback;
- the command-shape defaults above are covered by an exact fixture;
- resolution is pure apart from the injected snapshot/config reads.

#### Work package 4: implement idempotent standard ingress

Implement one shared `startStandardIngress` operation:

1. Derive the deterministic `ThreadId`, initial `MessageId`, and create/start
   `CommandId`s.
2. Read `GET /api/orchestration/threads/:threadId`.
3. If absent, HTTP-dispatch deterministic `thread.create` with the resolved
   `projectId`, prompt-derived title, selected model, `runtimeMode:
   "full-access"`, `interactionMode: "default"`, `branch: null`, and
   `worktreePath: null`. `thread.create` has no `workspaceRoot` field; T3 resolves
   the registered project root when `worktreePath` is null.
4. Read/reconcile the thread after an ambiguous create response.
5. If the deterministic initial message is absent, HTTP-dispatch deterministic
   `thread.turn.start` without `bootstrap`, with the same selected model,
   prompt-derived `titleSeed`, `runtimeMode: "full-access"`, and
   `interactionMode: "default"`.
6. Read/reconcile the thread after an ambiguous start response.
7. If the initial message is present, return the existing conversation rather
   than dispatching another turn.
8. Build the deep link as
   `{publicBaseUrl}/{encodeURIComponent(environmentId)}/{encodeURIComponent(threadId)}`.

Recovery classification is observable but does not change the user promise:

- `created`: this call completed create and start;
- `resumed`: a partial prior attempt existed and this call completed it;
- `already-started`: the deterministic initial message already existed;
- `unverified`: T3 could not be queried well enough to prove the final state.

The current HTTP endpoint maps every orchestration engine dispatch failure to the
same `EnvironmentInternalError`; it does not expose a typed known-rejection versus
ambiguous-outcome distinction. Reconcile after either a transport-level ambiguous
outcome or dispatch `EnvironmentInternalError`. Return `unverified` only when the
required snapshot reconciliation is unavailable or inconclusive. Other typed HTTP
failures, such as authentication, authorization, invalid request, and a snapshot
404, retain their contract-defined meaning.

Review exit:

- retries cannot create a second thread or initial message;
- standard ingress never sends a bootstrap payload;
- create/start fixtures lock title, title seed, model, modes, branch, and
  `worktreePath`;
- recovery decisions are made from T3 snapshots, not local memory;
- the operation has no Slack-aware branches.

#### Work package 5: add the thin Slack adapter

Scaffold `apps/slack` with Bolt in Socket Mode and centralize Slack command,
event, action, and metadata identifiers.

For `/t3 <prompt>` and an ordinary `app_mention`:

1. Acknowledge within Slack's deadline before any T3 I/O.
2. Normalize the prompt (including removal of the app mention token).
3. Reject an empty prompt with usage guidance and no T3 dispatch.
4. Post a visible `Starting...` response.
5. Translate the payload into `IngressInvocation` and call the shared operation.
6. Replace the starting response with `Open in T3 Code`, a safe recoverable
   failure, or an unverified message containing the public T3 base URL.
7. Attach only deterministic T3/origin IDs to Slack message metadata; never place
   prompts, bearer credentials, or Slack tokens there.

An ordinary mention is one explicit `app_mention` event. Its identity comes from
the event ID or the mention message timestamp, never the surrounding Slack thread
root. Replies may be posted in the originating channel/thread for Slack UX, but
that reply location does not participate in T3 identity. Messages that do not
arrive through the registered slash-command or `app_mention` handlers cannot
start or steer a conversation in Slice 1.

Before adapter implementation, record the reviewed response placement in the
Slack manifest/config section. Slash commands cannot be invoked from a Slack
message thread, so they require only an ephemeral-versus-channel-visible decision.
For mentions, separately decide whether the response is posted at the channel
root or in the originating message thread. These choices affect Slack visibility,
not the shared runtime.

Review exit:

- handlers acknowledge before invoking the runtime;
- Slack retry delivery produces the same shared request identity;
- a mention in an existing human thread does not key from that root;
- follow-up messages have no dispatch handler;
- all terminal states replace the visible starting state when Slack delivery is
  available.

#### Work package 6: configuration, health, and observability

Decode startup configuration rather than reading environment variables throughout
the app. Slice 1 configuration covers:

- internal T3 HTTP/WS base URL;
- public T3 base URL;
- bearer credential file path;
- configured workspace `ProjectId`;
- optional integration-wide `ModelSelection`;
- Slack app-level and bot tokens;
- health/listen configuration required by the deployment environment.

Separate process liveness from readiness:

- live: the process and health endpoint/event loop are running;
- ready: configuration decoded, credential file is readable, Slack Socket Mode is
  connected, T3 authentication/scopes were validated, `server.getConfig`
  succeeded, the configured project is present in the shell snapshot, and the
  configured/project default model currently resolves;
- degraded/not ready: retain the process for reconnection and diagnostics, but do
  not claim it can accept ingress.

Log correlation IDs, phase, recovery classification, and safe error categories.
Never log prompts by default, bearer credentials, Slack tokens, WS tickets, full
Slack payloads, or authorization headers.

#### Slice 1 focused verification

`packages/integration-runtime` tests:

- deterministic ID snapshots for slash and mention identities and every phase;
- public deep-link normalization and thread-ID URL encoding;
- integration default wins over project default;
- missing/stale project and invalid/unavailable model selections fail closed;
- create/start command fixtures use the prompt-derived title/title seed,
  `full-access`, `default`, `branch: null`, and `worktreePath: null`;
- absent thread creates then starts;
- existing thread without the initial message starts only;
- existing thread with the initial message returns `already-started`;
- ambiguous create/start reconciles through a successful snapshot;
- unavailable reconciliation returns `unverified`;
- reconnect obtains a fresh WS ticket.

`apps/slack` tests with a fake shared runtime:

- acknowledgement occurs before T3 work;
- slash and mention payloads normalize to the expected stable identity;
- mention markup is removed and empty prompts are rejected;
- a mention uses its own event/message identity, not a parent thread root;
- starting state transitions to success, safe failure, or unverified;
- Slack metadata contains IDs only;
- ordinary messages and follow-ups do not dispatch.

Add one focused adapter-to-runtime integration test covering Slack payload ->
deterministic T3 commands -> returned deep link. Run targeted tests and typechecks
for the two new workspaces only; do not run the repo-wide suite.

Disposable-environment verification recorded 2026-07-31:

- a slash invocation created one current-checkout conversation and identical
  redelivery returned `already-started` with one persisted initial message;
- mention ingress preserved a separate human mention and persisted
  `branch: null` plus `worktreePath: null`;
- a rejected dispatch decoded to `T3TransportError(kind: "internal")`;
- after the disposable T3 server stopped and restarted, the retained transport
  reconnected with a fresh usable WebSocket ticket.

This is server/runtime evidence only. Testing in a real Slack workspace is
deliberately deferred until a later phase has enough product surface to justify
workspace installation and operational testing.

#### Slice 1 review gates

Implementation starts after reviewers agree on:

1. the package name (`packages/integration-runtime` unless repository naming
   review selects another name);
2. the exact versioned deterministic-ID encoding;
3. the evidenced stable slash-command retry identity;
4. slash-command response visibility and mention response visibility/thread
   placement;
5. the decoded configuration keys and readiness contract;
6. the incremental package boundary: snapshot-based standard ingress now,
   selectors/bootstrap/projection added only in later slices.

Slice 1 is complete when the standard slash and mention acceptance criterion is
demonstrated against a disposable T3 environment, focused tests/typechecks pass,
and the implementation has not modified server orchestration behavior.

### Slice 2: Bootstrap extraction and custom setup

- Extract `ThreadBootstrapService` with focused behavior-parity tests.
- Implement live project/ref/provider projection.
- Implement four-control modal.
- Implement Current root-checkout branch switching.
- Implement existing-worktree discovery and continuation.
- Implement New worktree bootstrap.
- Add custom slash/mention and DM setup flows.

### Slice 3: App Home

- Implement a sequence-aware shell projection that resumes after reconnect.
- Select newest-first conversations across every project, omitting archived,
  effectively snoozed, and—temporarily for this slice—server-explicit settled rows
  without pending approval or user-input blockers.
- Render status, title, project, and direct thread link up to the Block Kit Home
  limit.
- Implement per-user-on-open publication, content-hashed debounced live refresh,
  and snooze-wake refresh.
- Add an environment-root `View all` truncation footer.

#### Slice 3 acceptance criteria

Shell projection and lifecycle:

- Seed from the HTTP shell snapshot, then subscribe through
  `orchestration.subscribeShell` using the latest projected sequence as
  `afterSequence`.
- Apply authoritative replacement snapshots plus project/thread upserts and
  removals. Ignore duplicate or out-of-order incremental events whose sequence
  is not newer than the current projection.
- After a WebSocket disconnect, obtain a fresh short-lived ticket, reconnect,
  and resume from the last applied sequence. Retry typed failures and defects
  with bounded backoff rather than terminating the projection or entering a tight
  reconnect/logging loop.
- Starting the projection is idempotent. Process shutdown cancels projection and
  publication timers and closes the retained T3 WebSocket, Slack connection, and
  health server. Transport closure is terminal: every public HTTP and WebSocket
  operation invoked after close begins rejects before reading credentials,
  fetching, or reconnecting. Shutdown during pending Slack startup or readiness
  cannot subsequently start App Home, install timers, or create another T3
  connection, and pending lifecycle work is tracked through teardown.

Task selection and ordering:

- Consider conversations from every project in the environment, not only the
  project configured for standard Slack starts.
- Omit archived conversations.
- Omit conversations for which T3's shared `effectiveSnoozed` helper returns
  true. A timer at the earliest future snooze boundary must make a conversation
  visible without requiring a shell event.
- As a temporary Slice 3 scope reduction, omit server-explicit settled
  conversations (`settledOverride === "settled"`) unless pending approval or
  user-input blockers must remain visible. Slack must not infer settlement from
  age, change-request state, or any separate auto-settle policy. The intended
  future behavior remains unsettled-first followed by the newest settled rows.
- Sort eligible conversations by `createdAt` descending, matching the inbox-based
  sidebar's static ordering, and break equal or malformed timestamp ties by
  thread ID ascending.
- If a thread temporarily refers to a project absent from the same shell
  projection, do not publish a misleading project label for it.

Rows, links, and Block Kit limits:

- Every row shows the conversation title followed by status and project title,
  and links directly to
  `{publicBaseUrl}/{encodeURIComponent(environmentId)}/{encodeURIComponent(threadId)}`.
- Status precedence is: pending approval (`Pending approval`), pending user input
  (`Awaiting input`), starting session (`Connecting`), running session
  (`Working`), failed session (`Failed`), actionable plan-mode proposal
  on a settled latest turn (`Plan ready`), then `Ready`.
- Normalize, escape, and bound user-controlled titles before placing them in
  Slack mrkdwn.
- A Slack Home tab permits 100 blocks. Reserve one header block. When all rows
  fit, publish up to 99 rows with no footer. When rows overflow, reserve one
  footer block and publish the newest 98 rows, for at most 100 blocks total.
- The header links to the main environment URL
  `{publicBaseUrl}/{encodeURIComponent(environmentId)}`. On overflow, the footer
  reports the visible and total active counts and links `View all in T3 Code` to
  that same environment URL. Individual row links remain direct conversation links.
- With no eligible conversations, publish the linked header plus a bounded empty
  state. If T3 data is unavailable during an open, still publish a safe unavailable
  view without exposing internal errors or credentials. When environment
  resolution itself is unavailable, that fallback header links to the raw
  `publicBaseUrl` because no environment ID is available.

Publication behavior:

- Register and enable Slack App Home in the manifest and subscribe to
  `app_home_opened`.
- Every Home-tab `app_home_opened` publishes a fresh view for `event.user`, even
  when its content matches that user's previously published view. Messages-tab
  opens do not enroll users in live App Home publication.
- Keep only an in-memory set of users observed during the current process.
  Debounce shell-driven live refreshes for those users, compare per-user content
  hashes, and skip unchanged live publications. Publications for a user are
  serialized and queued renders use the latest accepted snapshot, so completion
  order cannot rewind Slack or the stored content hash.
- An open-time HTTP refresh must re-read the projection after success or failure.
  Open-time snapshot adoption is sequence- and stream-epoch-aware: it cannot
  replace a newer live snapshot with `null`, an older snapshot, or a numerically
  higher HTTP response started before an authoritative stream reset. Authoritative
  stream replacement snapshots may still reset sequence after a server restart.
- Isolate publication failures per user so one Slack API failure does not prevent
  refreshes for other observed users. Logs contain only safe categories and IDs,
  never prompts, credentials, tickets, tokens, or full Slack payloads.
- App Home owns no durable Slack user or publication state. After restart, users
  are republished when they next open App Home.

Verification boundary:

- Focused integration-runtime and Slack tests cover snapshot/replay convergence,
  reconnect/resume, defect recovery, removals and stale events, filtering and
  ordering, every projected status and precedence collisions, 99-row exact fit,
  98-row overflow, URLs, empty/unavailable states,
  per-open publication, serialized/coalesced publication races, failed and delayed
  pre-reset refreshes versus live snapshots, live deduplication, failure isolation,
  snooze wakes, Home-versus-Messages tab handling, manifest wiring, post-close HTTP
  and WebSocket rejection without network access, pending-connect cancellation,
  and shutdown during delayed Slack startup and readiness.
- Targeted lint, formatting, and typechecks pass for the affected packages.
- A live Slack workspace installation is an operational verification step, not a
  completion requirement for Slice 3; if it has not been performed, the handoff
  states that explicitly.

#### Slice 3 implementation evidence (2026-08-02)

- Focused integration-runtime and Slack tests, targeted typechecks, lint,
  formatting, and diff checks passed after the implementation review.
- The reconnecting live connection factory re-reads the bearer credential and
  requests a fresh short-lived WebSocket ticket for every replacement session.
- No live Slack workspace installation was performed or recorded. That remains an
  operational verification step outside the Slice 3 completion requirement.

### Slice 4: Operations

- Add credential rotation script/timer documentation.
- Add service environment/config documentation.
- Add health/readiness logging and expiry warnings.
- Document manual recovery and known best-effort delivery window.

#### Slice 4 acceptance criteria

Credential rotation:

- A timer-safe command checks the daemon and administrative rotator bearer
  sessions daily and rotates either credential when it has 10 days or less
  remaining (day 20 of the current 30-day bearer lifetime).
- The rotator credential is read from a separate root-owned file and must have
  `access:read`, `access:write`, `orchestration:read`, and
  `orchestration:operate`. A newly issued daemon credential is accepted only
  when it has exactly the two orchestration scopes; a replacement rotator must
  have exactly the four administrative/delegated scopes.
- An authenticated existing daemon with missing, duplicate, or additional scopes
  is treated as due and replaced rather than leaving automatic recovery blocked.
- Credential files are replaced atomically in their existing directory with
  mode `0600` (and the existing owner when run with sufficient privilege).
  Tokens, pairing credentials, and response bodies are never logged.
- After daemon credential replacement, the command restarts the configured
  Slack service and waits for `/ready`. Only then does it revoke the daemon's
  previously labelled sessions. A failed restart/readiness check restores the
  previous daemon credential atomically, restarts the service again, and leaves
  the old session valid.
- Rotator self-rotation validates and installs the new rotator before using it
  to revoke the prior rotator session. A `--dry-run` mode reports whether each
  credential is due without issuing, replacing, restarting, or revoking.
- Every non-dry run reconciles contract-shaped `client.label` session listings,
  retains the uniquely identified installed daemon/current rotator sessions,
  and retries stale labelled-session revocation even when no credential is due.
  Before later-run daemon cleanup it restarts and verifies Slack to close the
  source-replaced/runtime-copy-not-reloaded crash window. Ambiguous active-session
  identity fails closed instead of revoking.

Health and observability:

- `/live` continues to represent process liveness and `/ready` continues to
  require Slack connectivity plus valid T3 authentication, exactly the two
  daemon scopes, server config, project, and model resolution.
- Connection generations and readiness-attempt versions prevent an older check
  from committing success after disconnect or overwriting a newer result.
- Readiness changes are logged once per state transition, including startup,
  reconnect/disconnect, recovery, and shutdown; repeated 30-second checks do
  not repeat an unchanged failure warning. Credential-expiry observation is
  independent and cannot clear or replay the current readiness category.
- The daemon reads the bearer expiry returned by `/api/auth/session` and emits
  a safe warning, containing the expiry time and remaining whole days but no
  credential, when 10 days or less remain. The warning is transition-based so
  it does not repeat on every readiness poll.

Deployment and recovery documentation:

- Checked-in systemd service/timer and environment examples enumerate every
  Slack and rotation setting, use separate root-owned credential files, bind
  health to loopback, run the timer daily, and make process/PID ownership
  explicit.
- The operator guide covers initial narrow credential issuance, installation,
  health checks, rotation dry runs, day-20 automatic rotation, logs/alerts,
  upgrades, manual recovery after expiry, rollback behavior, and revocation.
- The guide explicitly describes the best-effort window between Slack
  acknowledgement, T3 dispatch/reconciliation, and Slack response replacement,
  including the stronger current-checkout replay behavior and the known partial
  New-worktree bootstrap limitation.
- Focused rotation, configuration, health/observability, and existing Slack
  tests pass together with targeted Slack typecheck, lint, and formatting.

#### Slice 4 implementation evidence (2026-08-03)

- All 83 focused Slack tests passed. Coverage includes threshold/no-op, dry-run,
  exact and malformed scope sets, contract-shaped client labels, rotation
  ordering, cleanup retry, rollback cleanup, atomic durable file replacement,
  expiry warnings, transition-only health, failure-category changes, and
  readiness races.
- Targeted Slack typecheck, lint, formatting, diff checks, and systemd unit/timer
  verification passed. Any verifier warnings came from unrelated pre-existing
  host units rather than the checked-in Slack units.
- The rotation entrypoint's configuration-failure path was executed directly and
  produced a structured, non-secret warning with a nonzero exit.
- No live T3 administrative credential was issued and no real systemd service was
  restarted or Slack workspace exercised. Those remain deployment-time
  operational checks; the rotation workflow is covered through injected focused
  tests and checked-in unit validation.

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

- conversations from every project are eligible;
- archived and effectively snoozed conversations are omitted;
- server-explicit settled conversations without pending approval or user-input
  blockers are omitted as temporary Slice 3 scope, while preserving the future
  unsettled-first plus settled-tail behavior;
- unsettled rows sort newest-created-first with deterministic ID ties;
- block count stays within Slack limits;
- overflow reserves a footer block linked to the main environment URL;
- identical content is published separately for each Home-tab opening user;
- per-user writes are serialized and converge on the newest snapshot;
- unchanged live content is not republished, while snooze timer wakes republish
  without requiring a shell event.

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
- App Home shows as many newest-first conversations across all projects as Block
  Kit permits, temporarily omitting server-explicit settled conversations unless
  pending approval or user-input blockers must remain visible.
- Every App Home open on the Home tab gets a fresh per-user publication of the
  same team-wide view; Messages-tab opens do not publish.
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
- Server-explicit settled conversations without pending approval or user-input
  blockers are temporarily absent from App Home; a later slice can restore the
  intended newest-settled tail after unsettled work.
- Cost controls are organizational rather than technical in v1.
