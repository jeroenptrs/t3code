# Operating Slack ingress

The Slack app is a stateless sibling of the T3 server. Run it under its own
service account, use loopback/private networking for T3 API traffic, and expose
only the separately configured public T3 URL in Slack links. The checked-in
examples in `apps/slack/deploy` use systemd and make service ownership explicit.

## Install the service

Install the repository and workspace dependencies at `/opt/t3-code`, or adjust
`WorkingDirectory` and the Node path in the unit files. Create an unprivileged
`t3-slack` system user. Copy the two environment examples to
`/etc/t3-slack/slack.env` and `/etc/t3-slack/rotation.env`, fill in every required
value, and set both to `root:root` mode `0600`.

Credential sources live under `/etc/t3-slack/secrets`, owned by `root:root` with
mode `0600`. The daemon unit uses systemd `LoadCredential`, so the unprivileged
process sees only a protected runtime copy of its bearer. It never receives the
administrative rotator bearer. The rotation unit runs as root only long enough
to atomically replace credential sources and restart the daemon.

| Variable                            | Required | Meaning                                    |
| ----------------------------------- | -------- | ------------------------------------------ |
| `SLACK_APP_TOKEN`                   | yes      | Socket Mode app-level token                |
| `SLACK_BOT_TOKEN`                   | yes      | Slack bot token                            |
| `T3_HTTP_URL`                       | yes      | Private T3 HTTP origin; WS derives from it |
| `T3_PUBLIC_URL`                     | yes      | Public origin used only for Slack links    |
| `T3_PROJECT_ID`                     | yes      | Project used by standard starts            |
| `T3_MODEL_SELECTION`                | no       | Complete JSON model-selection override     |
| `SLACK_HEALTH_HOST`                 | no       | Health bind host; keep at `127.0.0.1`      |
| `SLACK_HEALTH_PORT`                 | no       | Health port; default `3210`                |
| `T3_CREDENTIAL_EXPIRY_WARNING_DAYS` | no       | Warning window; default `10`               |
| `SLACK_CONVERSATION_AUDIT_LOG_FILE` | no       | Conversation-start JSONL audit path        |

The rotation job reads:

| Variable                            | Required | Meaning                                                      |
| ----------------------------------- | -------- | ------------------------------------------------------------ |
| `T3_HTTP_URL`                       | yes      | Private T3 HTTP origin                                       |
| `T3_BEARER_CREDENTIAL_FILE`         | yes      | Root-owned daemon source credential                          |
| `T3_ROTATOR_CREDENTIAL_FILE`        | yes      | Root-owned rotator credential                                |
| `T3_DAEMON_CREDENTIAL_LABEL`        | no       | Stable daemon label; default `t3-slack-daemon`               |
| `T3_ROTATOR_CREDENTIAL_LABEL`       | no       | Stable rotator label; default `t3-slack-rotator`             |
| `T3_CREDENTIAL_ROTATE_BEFORE_DAYS`  | no       | Rotation window; default `10`                                |
| `SLACK_SYSTEMD_SERVICE`             | no       | Unit restarted after replacement; default `t3-slack.service` |
| `SLACK_READY_URL`                   | no       | Post-restart readiness URL                                   |
| `SLACK_ROTATION_REQUEST_TIMEOUT_MS` | no       | Per-request timeout; default 10000                           |
| `SLACK_ROTATION_READY_TIMEOUT_MS`   | no       | Post-restart budget; default 60000                           |

Install and start the units with:

```sh
install -o root -g root -m 0644 \
  apps/slack/deploy/t3-slack.service \
  /etc/systemd/system/t3-slack.service
install -o root -g root -m 0644 \
  apps/slack/deploy/t3-slack-credential-rotation.service \
  /etc/systemd/system/t3-slack-credential-rotation.service
install -o root -g root -m 0644 \
  apps/slack/deploy/t3-slack-credential-rotation.timer \
  /etc/systemd/system/t3-slack-credential-rotation.timer
systemctl daemon-reload
systemctl enable --now t3-slack.service
systemctl enable --now t3-slack-credential-rotation.timer
```

The examples intentionally do not name a T3 server unit: `t3 service install`
creates a user-scoped `t3code.service`, which a system-scoped Slack unit cannot
order against directly. Slack remains not-ready and reconnects until T3 is
available; the daily rotation job exits nonzero and is retried on its next run.

`/live` returns 200 while the process/event loop is alive. `/ready` returns 200
only after Slack Socket Mode connects, the T3 bearer authenticates with exactly
the two required orchestration scopes, `server.getConfig` succeeds, and the
configured project/default model resolves. Alert on repeated `/ready` failures and on
`slack.credential.expiry-warning` or `slack.rotation.failed` journal events.
Readiness is logged only when it changes, so a persistent failure does not emit
the same warning every 30 seconds.

The provided service sets `StateDirectory=t3-slack`, and the example environment
writes append-only conversation-start records to
`/var/lib/t3-slack/conversation-starts.jsonl`. Each line contains a prompt and
Slack user ID, so restrict the directory to the service account and apply the
organization's retention policy. A write failure prevents the corresponding T3
dispatch; check the state directory's ownership and available space when an
ingress start fails unexpectedly.

## Bootstrap narrow credentials

The daemon must have exactly `orchestration:read orchestration:operate`. The
rotator must have exactly `access:read access:write orchestration:read
orchestration:operate`: read identifies old labelled sessions, write issues and
revokes them, and the orchestration scopes are the maximum it may delegate.

Create a short-lived administrative bootstrap with `npx t3@latest auth session
issue --base-dir /srv/t3 --json`. Present its bearer to
`POST /api/auth/pairing-token` twice: once with the daemon's exact two-scope array
and once with the rotator's exact four-scope array. Exchange each returned
one-time credential through `POST /oauth/token`, requesting the same exact scope
string and setting `client_device_type=bot` plus the labels from `rotation.env`.
Atomically write only each `access_token` to its matching secret file with mode
`0600`. Validate both via `/api/auth/session`, then revoke the temporary session:

```bash
set -euo pipefail
set +x
umask 077

T3_BASE_DIR=/srv/t3
T3_INTERNAL_URL=http://127.0.0.1:3773
DAEMON_LABEL=t3-slack-daemon
ROTATOR_LABEL=t3-slack-rotator

ADMIN_JSON="$(npx t3@latest auth session issue --base-dir "$T3_BASE_DIR" --json)"
ADMIN_TOKEN="$(printf '%s' "$ADMIN_JSON" | jq -er .token)"
ADMIN_SESSION_ID="$(printf '%s' "$ADMIN_JSON" | jq -er .sessionId)"
install -d -o root -g root -m 0700 /etc/t3-slack/secrets
bootstrap_tmp="$(mktemp -d /etc/t3-slack/secrets/.bootstrap.XXXXXX)"
trap 'rm -rf "$bootstrap_tmp"' EXIT
printf 'authorization: Bearer %s\n' "$ADMIN_TOKEN" >"$bootstrap_tmp/admin.header"

issue_token() {
  local label="$1"
  local scopes_json="$2"
  local scopes_text="$3"
  local pairing_json pairing_file
  pairing_file="$bootstrap_tmp/pairing-$label"
  pairing_json="$(
    jq -nc --arg label "$label" --argjson scopes "$scopes_json" \
      '{label: $label, scopes: $scopes}' |
      curl --fail --silent --show-error \
        --request POST "$T3_INTERNAL_URL/api/auth/pairing-token" \
        --header @"$bootstrap_tmp/admin.header" \
        --header 'content-type: application/json' --data-binary @-
  )"
  printf '%s' "$pairing_json" | jq -er .credential >"$pairing_file"
  curl --fail --silent --show-error \
    --request POST "$T3_INTERNAL_URL/oauth/token" \
    --header 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
    --data-urlencode "subject_token@$pairing_file" \
    --data-urlencode 'subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap' \
    --data-urlencode 'requested_token_type=urn:ietf:params:oauth:token-type:access_token' \
    --data-urlencode "scope=$scopes_text" \
    --data-urlencode "client_label=$label" \
    --data-urlencode 'client_device_type=bot' | jq -er --arg scope "$scopes_text" \
      'select(.token_type == "Bearer" and .scope == $scope) | .access_token'
}

DAEMON_TOKEN="$(issue_token "$DAEMON_LABEL" \
  '["orchestration:read","orchestration:operate"]' \
  'orchestration:read orchestration:operate')"
ROTATOR_TOKEN="$(issue_token "$ROTATOR_LABEL" \
  '["access:read","access:write","orchestration:read","orchestration:operate"]' \
  'access:read access:write orchestration:read orchestration:operate')"

daemon_tmp="$bootstrap_tmp/daemon.token"
rotator_tmp="$bootstrap_tmp/rotator.token"
printf '%s\n' "$DAEMON_TOKEN" >"$daemon_tmp"
printf '%s\n' "$ROTATOR_TOKEN" >"$rotator_tmp"
chmod 0600 "$daemon_tmp" "$rotator_tmp"
chown root:root "$daemon_tmp" "$rotator_tmp"
mv -f "$daemon_tmp" /etc/t3-slack/secrets/t3-daemon.token
mv -f "$rotator_tmp" /etc/t3-slack/secrets/t3-rotator.token

printf 'authorization: Bearer %s\n' "$DAEMON_TOKEN" >"$bootstrap_tmp/daemon.header"
printf 'authorization: Bearer %s\n' "$ROTATOR_TOKEN" >"$bootstrap_tmp/rotator.header"
curl --fail --silent "$T3_INTERNAL_URL/api/auth/session" \
  --header @"$bootstrap_tmp/daemon.header" | jq -e \
  '.authenticated and .scopes == ["orchestration:read","orchestration:operate"]'
curl --fail --silent "$T3_INTERNAL_URL/api/auth/session" \
  --header @"$bootstrap_tmp/rotator.header" | jq -e \
  '.authenticated and (.scopes | sort) == (["access:read","access:write","orchestration:read","orchestration:operate"] | sort)'

npx t3@latest auth session revoke --base-dir "$T3_BASE_DIR" "$ADMIN_SESSION_ID"
```

Do not use the broad token from `auth session issue` as either persistent
credential. Never place tokens in environment/unit files, shell history, URLs,
logs, or the repository.

## Automatic rotation

Bearer sessions currently last 30 days. The timer checks daily and rotates at 10
days remaining, targeting day 20. Exercise its complete read/validation path
without mutation first:

```sh
cd /opt/t3-code
set -a
. /etc/t3-slack/rotation.env
set +a
node --experimental-strip-types apps/slack/src/rotateCredentialMain.ts --dry-run

systemctl start t3-slack-credential-rotation.service
journalctl -u t3-slack-credential-rotation.service --since today
```

Daemon rotation issues and validates an exact-scope replacement, atomically
replaces the source file, restarts `t3-slack.service`, and waits for `/ready`
before revoking previously labelled daemon sessions. If restart/readiness fails,
it restores the old bearer atomically, restarts again, keeps old sessions valid,
best-effort revokes the failed replacement, exits nonzero, and emits an actionable warning.

Every non-dry timer run also reconciles labelled daemon and rotator sessions.
Failed revocations are therefore retried on the next run even when the installed
replacement is not yet due. An installed daemon with missing or extra scopes is
treated as due and replaced with an exact-scope credential. Before a later run
revokes stale daemon sessions without issuing a new credential, it restarts and
verifies Slack so a systemd `LoadCredential` runtime copy cannot lag behind the
installed source after a prior crash.

Rotator self-rotation issues and validates its replacement, installs it
atomically, then uses the new bearer to revoke the prior rotator session. Logs
contain only safe operational correlation fields such as categories, opaque
session IDs, expiry timestamps, remaining days, and counts—never credentials,
pairing tokens, authorization headers, or HTTP response bodies.

## Manual recovery and rollback

If rotation misses expiry—or an incorrectly scoped rotator prevents automatic
repair—`/ready` becomes unavailable. Create another temporary administrative
session locally, repeat both exact-scope pairing/token exchanges, atomically
replace both root-owned files, restart, and verify:

```sh
curl --fail --silent http://127.0.0.1:3210/live
curl --fail --silent http://127.0.0.1:3210/ready
journalctl -u t3-slack.service -n 100 --no-pager
```

List sessions with `npx t3@latest auth session list --base-dir /srv/t3 --json`.
Revoke stale labelled session IDs only after readiness succeeds. For a failed
deployment, restore the prior application version and credential files, restart,
verify readiness, and retain old sessions until verification completes.

## Best-effort delivery window

Slack acknowledgement, T3 dispatch, and the final Slack update cannot be one
transaction. A crash after acknowledgement can leave `Starting...` visible; a
crash after dispatch can leave a valid T3 conversation without its Slack link.
Redelivery uses deterministic IDs. Current-checkout starts reconcile T3 snapshots
and can resume a missing create/start phase without duplicating the thread or
initial message.

New-worktree bootstrap is weaker: its server workflow is not phase-resumable
across every partial preparation failure, so retry may remain unverified while T3
finishes or cleans up. Ambiguous outcomes are queried before uncertainty is
reported, with a public environment link when verification is impossible. Slack
stores an append-only security audit of requested starts but no durable domain
state; T3 is the recovery directory.

## Upgrade and uninstall

Update the checkout and dependencies, run focused Slack verification, restart the
daemon, and verify `/ready`. To uninstall, disable both units, revoke labelled
daemon and rotator sessions, and then remove `/etc/t3-slack`. Slack manifest
changes still require applying the manifest and reinstalling the Slack app.
