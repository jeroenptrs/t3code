# Deploying the Slack conversation portal

This deployment exposes the T3 web client without a T3 pairing or login prompt. It is intended for
a trusted team whose members may see and operate every conversation in the environment.

The public browser is anonymous, but T3 itself does not run without authentication. A reverse proxy
holds a shared, narrowly scoped bearer credential and adds it to requests sent to T3. This preserves
T3's existing scope checks and leaves one boundary where OIDC can be enabled later.

```text
browser -> HTTPS reverse proxy -> T3 on 127.0.0.1:3773
                  |
                  +-- adds shared orchestration-only bearer credential

Slack  -> T3_HTTP_URL=http://127.0.0.1:3773 (its own bearer credential)
       -> T3_PUBLIC_URL=https://t3.example.com (links sent to users)
```

## Security boundary

The shared portal credential grants:

- `orchestration:read`
- `orchestration:operate`

Those scopes are environment-wide and are broader than conversation-only access. Anyone who can
reach the portal can see all projects, conversations, filesystem/VCS state, and server configuration
exposed by this T3 environment. `orchestration:operate` also covers agent turns, settings and
provider changes, filesystem/source-control operations, previews, and server maintenance actions.
It does not grant terminal, review-preview, access-management, or relay operations.

Deploy this only behind the intended network boundary, and add rate limiting appropriate for the
provider account. Prefer a dedicated T3 environment and provider account when this surface should
not affect other work. The proxy is an access mechanism, not a sandbox or conversation-only client.
Do not use an administrative credential and do not reuse the Slack daemon's credential: separate
credentials give the portal and Slack independent revocation and rotation.

If anonymous users must only see the conversation named in a Slack deep link, this deployment is not
a security boundary. See [Optional thread-scoped access](#optional-thread-scoped-access).

## 1. Run T3 on a private listener

Keep T3 on loopback and let the reverse proxy be the only public listener. The normal web-mode
default is loopback; make it explicit in service configuration when possible:

```sh
npx t3@latest serve --host 127.0.0.1 --port 3773 --no-browser
```

Use the same explicit T3 home for the server and the credential commands below if the deployment
does not use the default T3 home. Never point a test or second server at a live T3 home.

Confirm from another machine that port `3773` is not reachable directly. Only the reverse proxy's
HTTPS port should be exposed.

## 2. Issue a narrow portal credential

The command-line `auth session issue` command currently grants administrative scopes, so do not use
it for the portal. Instead, create an ordinary pairing credential and exchange it for the exact
scope subset required by the portal.

Run the following on the T3 host. Replace `/srv/t3` if the server uses another explicit T3 home:

```sh
set -eu

T3_BASE_DIR=/srv/t3
T3_INTERNAL_URL=http://127.0.0.1:3773
PORTAL_LABEL="conversation-portal-$(date -u +%Y%m%d)"

PAIRING_JSON="$(
  npx t3@latest auth pairing create \
    --base-dir "$T3_BASE_DIR" \
    --label "$PORTAL_LABEL" \
    --json
)"
PAIRING_CREDENTIAL="$(printf '%s' "$PAIRING_JSON" | jq -er .credential)"

TOKEN_JSON="$(
  curl --fail --silent --show-error \
    --request POST "$T3_INTERNAL_URL/oauth/token" \
    --header 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
    --data-urlencode "subject_token=$PAIRING_CREDENTIAL" \
    --data-urlencode 'subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap' \
    --data-urlencode 'requested_token_type=urn:ietf:params:oauth:token-type:access_token' \
    --data-urlencode 'scope=orchestration:read orchestration:operate' \
    --data-urlencode "client_label=$PORTAL_LABEL" \
    --data-urlencode 'client_device_type=bot'
)"

printf '%s' "$TOKEN_JSON" | jq -e '
  .token_type == "Bearer" and
  .scope == "orchestration:read orchestration:operate"
' >/dev/null
PORTAL_TOKEN="$(printf '%s' "$TOKEN_JSON" | jq -er .access_token)"
```

Store `PORTAL_TOKEN` in the reverse proxy's secret store. Do not put it in a browser bundle, URL,
repository, unit file, shell history, or Slack configuration. The access token currently expires
after 30 days; record its expiry from `TOKEN_JSON.expires_in` and rotate it before then.

For nginx, one workable secret file is a root-owned include containing only:

```nginx
proxy_set_header Authorization "Bearer REPLACE_WITH_PORTAL_TOKEN";
```

For example, store that include as `/etc/nginx/t3-secrets/portal-authorization.conf` with directory
mode `0700` and file mode `0600`. nginx's privileged master process reads it during configuration
load. Follow the equivalent secret-loading mechanism when using another proxy.

## 3. Configure the reverse proxy

The example below assumes TLS is already configured for `t3.example.com`. The WebSocket upgrade and
query string must pass through unchanged: the web client first calls
`/api/auth/websocket-ticket`, then opens `/ws?wsTicket=...`.

Put the `map` block in nginx's `http` context:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

Then configure the public server:

```nginx
upstream t3_portal_backend {
    server 127.0.0.1:3773;
    keepalive 16;
}

server {
    listen 443 ssl;
    server_name t3.example.com;

    # TLS configuration is deployment-specific.

    location /api/ {
        proxy_pass http://t3_portal_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # Always use the portal identity. Do not let a browser cookie or header
        # replace it with a broader T3 session.
        proxy_set_header Cookie "";
        proxy_hide_header Set-Cookie;
        include /etc/nginx/t3-secrets/portal-authorization.conf;
    }

    location /ws {
        proxy_pass http://t3_portal_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Cookie "";
        include /etc/nginx/t3-secrets/portal-authorization.conf;
    }

    # Pairing and token exchange are host-local deployment operations. The
    # anonymous portal does not need to expose them.
    location = /oauth/token {
        return 404;
    }

    location = /api/auth/browser-session {
        return 404;
    }

    location / {
        proxy_pass http://t3_portal_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Setting `Authorization` in the proxy replaces any value supplied by the browser. Stripping cookies
prevents an old, more privileged T3 browser session from bypassing the portal's narrow identity.
The static application does not need the bearer credential, so the catch-all location does not add
it.

Validate and reload nginx using the deployment's normal procedure. Do not expose `/oauth/token`
through another proxy location; credential provisioning should use the loopback T3 URL.

## 4. Configure Slack links

Keep Slack's API traffic off the public portal route:

```text
T3_HTTP_URL=http://127.0.0.1:3773
T3_PUBLIC_URL=https://t3.example.com
T3_BEARER_CREDENTIAL_FILE=/run/secrets/t3-slack-bearer
```

`T3_BEARER_CREDENTIAL_FILE` contains Slack's own `orchestration:read
orchestration:operate` credential. `T3_PUBLIC_URL` is used only to construct the deep links returned
to Slack users.

## 5. Verify the deployment

First verify the session seen through the public proxy:

```sh
curl --fail --silent https://t3.example.com/api/auth/session | jq
```

It should report `authenticated: true` and exactly the two orchestration scopes. Then check that an
administrative endpoint remains forbidden:

```sh
curl --fail-with-body --silent https://t3.example.com/api/auth/pairing-links
```

The second command should return HTTP `403`. Finally, open a Slack-generated deep link in a private
browsing window. It should open the conversation without showing the T3 pairing screen, establish a
WebSocket connection, and permit a normal follow-up turn.

## 6. Rotate and revoke

Portal sessions currently expire after 30 days. Rotate before expiry:

1. Repeat the pairing and token exchange with a new dated label.
2. Write a new root-owned proxy secret file atomically.
3. Validate and gracefully reload the proxy.
4. Repeat the public session and `403` checks.
5. Run `npx t3@latest auth session list --base-dir /srv/t3 --json`, identify the previous
   `conversation-portal-*` session by label, and revoke its session ID with
   `npx t3@latest auth session revoke --base-dir /srv/t3 SESSION_ID`.

Keep a reminder or system timer ahead of expiry. Manual pairing and exchange over loopback is the
recovery path if rotation is missed.

## Add OIDC later

Add Entra ID or another OIDC provider at the reverse-proxy boundary. `oauth2-proxy`, nginx
`auth_request`, or an equivalent gateway can require the organization login before requests reach
the locations above. After successful OIDC authentication, continue injecting the same narrow T3
portal credential.

This transition changes the public access policy without changing T3, Slack, deep links, or the
browser/WebSocket flow. The gateway can log the authenticated employee, while T3 continues to see
one shared portal principal. That matches the team-shared conversation model.

Only add native T3 OIDC session issuance if T3 itself must distinguish users for authorization or
auditing. Do not forward an identity header to a publicly reachable T3 listener; any trusted-header
design must make the proxy the exclusive network path and strip client-supplied identity headers.

## Optional thread-scoped access

Thread-scoped authorization is not needed when every admitted team member may use the whole T3
environment. Consider it only if links may be shared with people who must not see the rest of the
environment.

That feature requires server-enforced capabilities tied to a thread ID and permitted operations,
plus filtered shell/project responses. A hidden sidebar or hard-to-guess thread ID is not an access
control. Treat this as a separate authorization feature, not an extension of the proxy deployment.
