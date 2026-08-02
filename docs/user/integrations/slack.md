# Slack ingress

The Slack integration starts T3 Code conversations and links users to the web
client. Slack is an ingress surface, not a second chat client: after a conversation
starts, continue working in T3 Code.

## Standard starts

- `/t3 <prompt>` starts a conversation and posts a channel-visible link. The
  submitted prompt is posted as a thread reply so the team can trace what started
  the T3 conversation.
- Mentioning the app with a prompt starts a conversation and replies in that
  message's thread.
- Each invocation targets the configured T3 project and its current checkout.
- The integration-wide model selection is used when configured; otherwise the
  project's default model selection is used.
- Empty prompts and missing or unavailable project/model configuration fail
  without creating a conversation.

Slack delivery retries resolve to the same deterministic T3 conversation. A
mention inside an existing Slack thread is still its own invocation. Ordinary
follow-up messages cannot add turns to or steer the T3 conversation.

## Custom starts

- `/t3-custom <prompt>` opens setup before starting. Submitting setup posts the
  same channel-visible link and threaded prompt trace as `/t3`.
- Mention the app with `custom:` followed by a prompt to receive a Configure
  button in that message's thread.
- Sending the app a direct message also returns a Configure button.

Custom setup always shows Project, Workspace, Branch, and Model / effort. The
prompt remains visible and editable in the modal. Current workspace mode can
switch the project root checkout or continue in the exact existing worktree
shown for a branch. New worktree mode uses the selected branch as its base,
inherits T3's start-from-origin setting, and runs the project's normal setup
script policy.

Projects, refs, worktree paths, and model capabilities are read from T3 and
validated again when the modal is submitted. A stale selection therefore fails
without creating a conversation. If the project configured for standard starts
was deleted, custom setup selects the first remaining project; standard starts
continue to report the configuration error until `T3_PROJECT_ID` is updated.

## App Home

Opening the app's Home tab shows active T3 Code conversations from every project
in the environment. Rows are ordered newest-first, matching the inbox-based T3
sidebar, and include status, conversation title, project, and a direct link.
Archived and effectively snoozed conversations are omitted. A snoozed conversation
can wake early and reappear when it raises its hand through a blocker, fresh
failure, or completion. As a temporary scope choice, server-explicit settled
conversations are also omitted unless they still carry a pending approval or
user-input blocker. The intended future view adds recent settled work after active
work.

The app renders as many rows as Slack's Home-tab Block Kit limit permits. If more
active conversations exist, `View all in T3 Code` opens the environment's main
URL. The Home view refreshes whenever it is opened and updates live for users who
have opened it during the current Slack process lifetime.

## Configuration

The sibling process reads:

| Variable                    | Purpose                                                |
| --------------------------- | ------------------------------------------------------ |
| `SLACK_APP_TOKEN`           | Socket Mode app-level token                            |
| `SLACK_BOT_TOKEN`           | Slack bot token                                        |
| `T3_HTTP_URL`               | Internal T3 HTTP origin; WebSocket URLs derive from it |
| `T3_PUBLIC_URL`             | Public origin used for links returned to Slack         |
| `T3_BEARER_CREDENTIAL_FILE` | File containing the narrow T3 bearer credential        |
| `T3_PROJECT_ID`             | Project used by standard starts                        |
| `T3_MODEL_SELECTION`        | Optional JSON-encoded complete model selection         |
| `SLACK_HEALTH_HOST`         | Health listener host; defaults to `127.0.0.1`          |
| `SLACK_HEALTH_PORT`         | Health listener port; defaults to `3210`               |

The T3 credential requires only `orchestration:read` and
`orchestration:operate`. The process rereads the credential file for every new
authenticated session so an atomic credential-file replacement is picked up.

To make the linked T3 conversation UI available without a T3 pairing prompt, deploy the public web
origin behind a reverse proxy that supplies a separate narrow portal credential. See
[Deploying the Slack conversation portal](../../integrations/slack-conversation-portal-deployment.md).

`/live` reports whether the process is alive. `/ready` becomes successful after
Slack Socket Mode connects, T3 authentication and scopes validate,
`server.getConfig` succeeds, and the configured project/default model resolves.

The Slack manifest is maintained in `apps/slack/manifest.yaml`. It enables Socket
Mode, App Home, `/t3`, `/t3-custom`, `app_home_opened`, `app_mention`, and
direct-message setup with only the required Slack scopes. After a slash command or
event subscription is added or changed, apply the updated
manifest to the Slack app and reinstall it in the workspace; deploying only the T3
Slack process does not register the Slack-side configuration.

## Delivery limitations

Delivery across Slack and T3 is idempotent and best-effort rather than
transactional. If a dispatch result is ambiguous, the integration checks T3's
thread snapshot before reporting success. If T3 cannot be reached to verify the
result, Slack shows an unverified message and the public T3 URL.

New-worktree starts use the server's WebSocket bootstrap workflow. A retry never
plain-starts a partially prepared worktree thread, so an interrupted bootstrap
may temporarily report an unverified result while T3 finishes or cleans up. The
bootstrap can reuse its deterministic branch or worktree on retry, but it does
not yet provide the HTTP current-workspace path's phase-by-phase replay guarantee.
Partial Current retries retain the project, model, branch, and exact workspace
mapping recorded by the deterministic T3 conversation; reopening setup cannot
retarget that conversation to a different checkout.

A process crash after Slack acknowledges an invocation but before dispatch or
response update can leave a starting message behind. T3 remains the recovery
directory; the Slack process owns no durable domain database.
