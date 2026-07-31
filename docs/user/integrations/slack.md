# Slack ingress

The Slack integration starts T3 Code conversations and links users to the web
client. Slack is an ingress surface, not a second chat client: after a conversation
starts, continue working in T3 Code.

## Standard starts

- `/t3 <prompt>` starts a conversation and returns an ephemeral link to the user.
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

`/live` reports whether the process is alive. `/ready` becomes successful after
Slack Socket Mode connects, T3 authentication and scopes validate,
`server.getConfig` succeeds, and the configured project/default model resolves.

The Slack manifest is maintained in `apps/slack/manifest.yaml`. It enables Socket
Mode, `/t3`, `app_mention`, and only the Slack scopes required by Slice 1.

## Delivery limitations

Delivery across Slack and T3 is idempotent and best-effort rather than
transactional. If a dispatch result is ambiguous, the integration checks T3's
thread snapshot before reporting success. If T3 cannot be reached to verify the
result, Slack shows an unverified message and the public T3 URL.

A process crash after Slack acknowledges an invocation but before dispatch or
response update can leave a starting message behind. T3 remains the recovery
directory; the Slack process owns no durable domain database.
