# Environment authentication

The environment issues its own sessions and enforces their capabilities. Cloud
identity and relay credentials belong to a separate trust boundary, described in
[T3 Connect](./t3-connect.md). A relay token is never an environment login.

## Authority survives transport changes

Pairing delegates a set of scopes. Exchanging a bootstrap credential can narrow
that grant but cannot widen it. Ordinary pairing does not grant access-management
or relay-management authority. Creating another pairing link requires both
`access:write` and every scope being delegated. The
[auth handlers](../../apps/server/src/auth/http.ts) enforce this at issuance;
client labels and device metadata have no authorization role.

The access read model contains pairing metadata, never recoverable pairing
secrets. Only the creation response returns the raw credential. Otherwise read
access to the connections list would become a way to acquire another client's
authority.

Browser cookies, bearer tokens, and DPoP tokens adapt the same scoped session
model. DPoP binds a token to a client's proof key; an invalid proof must fail
rather than fall back to bearer authentication. The OAuth token-exchange
vocabulary gives these grants a familiar meaning.

### MCP clients are a separate audience

Agents T3 Code did not launch sign in to `/mcp` through a narrow OAuth
authorization-code server ([McpOAuth](../../apps/server/src/auth/McpOAuth.ts)).
It accepts loopback redirect URIs for agents on the user's machine and any
HTTPS redirect for hosted agents (ChatGPT, bots). An HTTPS redirect means a
link someone else sends the owner can deliver access to that someone, so the
approval page names the host access goes to and approving stays the owner's
call. Every client is public and proves itself with PKCE; a client that asks
for a secret is registered without one. Client registration is stateless, so an unauthenticated caller cannot grow server
state. Approval spends a one-time pairing code, or uses a browser session with
`access:write`; proof-bound T3 Connect codes are refused without being spent.

The user grants either read-only access or a runtime-mode ceiling, not a
scope list: MCP tools are all orchestration, and `orchestration:operate`
alone would let an agent start a thread in full access and act through it.
The result is an ordinary session with subject `mcp-client`. A read-only
grant holds `orchestration:read` alone. On `/mcp` it passes only tools
declared as reads in [McpToolAccess](../../apps/server/src/mcp/McpToolAccess.ts),
where every tool must declare who may call it to compile. Any other grant adds
`orchestration:operate` and a signed ceiling. Only `/mcp` accepts these sessions. Every other HTTP and WebSocket
path rejects that subject, because the RPC surface would let the agent act
above its ceiling. Inside MCP the credential sets the limits and tool
parameters only pick targets; see
[threadAccess](../../apps/server/src/mcp/threadAccess.ts).

Issuer and resource URLs come from the request's Host and
`X-Forwarded-Proto`, so one server answers over loopback, Tailscale Serve and a
T3 Connect tunnel. A proxy that rewrites Host or drops the protocol header
breaks sign-in.

Bearer and DPoP clients obtain short-lived WebSocket tickets through authenticated
HTTP so long-lived tokens stay out of socket URLs. Browser sessions can
authenticate the upgrade with their cookie. A successful handshake grants no
extra authority: [every RPC declares a required
scope](../../apps/server/src/auth/RpcAuthorization.ts), and the WebSocket RPC
group's `RpcScopeAuthorization` middleware checks it before any handler runs.

Scope changes must not prevent older clients from connecting. Token exchange
intersects recognized requests with the pairing grant; retired and unknown names
are dropped. A request with no granted scopes fails before consuming the link.
Stored credentials are never expanded when scopes split.

Auth responses keep `scopes` within the original wire vocabulary and include
`permissions` for the exact grant. New clients use `permissions` when present,
even if empty. Older servers omit it, so clients use legacy parent checks for
features those servers already support. These client checks never change server
authorization. Permission errors likewise retain a legacy `requiredScope` and
add the exact `requiredPermission`, so a denied RPC stays decodable by old clients.
Unknown response permissions are ignored; grant inputs stay strict.

A socket checks RPCs against the scopes it was opened with, so it must not
outlive them. The [socket route](../../apps/server/src/ws.ts) races the
connection against `EnvironmentAuth.awaitSessionAccessChange` and closes it when
the session is revoked or its user's access changes; the client reconnects and
is authenticated again. Any other connection that outlives the request that
authorized it needs the same race; the [device hub
proxy](../../apps/server/src/device/DeviceHubProxy.ts) applies it to its sockets
and video streams. The signal comes from in-process streams, which the
host CLI, running as a separate process, cannot publish to. Its user commands
only grant access, so a socket that misses one holds less than it should. A
session revoked from the CLI keeps its open sockets until they reconnect.

Desktop restarts forget the previous local bearer token, so its reusable
bootstrap grant replaces earlier sessions for the same subject and method.
Revocation and insertion share a [database
transaction](../../apps/server/src/persistence/AuthSessions.ts); a failed
replacement must leave the old credential usable. Pairing and browser sessions
do not follow this replacement rule.

### Reusable dev credential

Web development environments can accept one `T3CODE_DEV_AUTH_TOKEN` across
worktrees and ports on one hostname. The token and startup URLs that contain it
grant administrative access. Desktop and non-development servers ignore it. See
the [development runbook](../operations/development.md#reusable-dev-credential)
for setup.

Each environment hashes the value and seeds its own database record at startup.
Environments do not share SQLite data, signing keys, environment IDs, session
records, pairing grants, or revocation state. Local revocation persists after
restart and does not affect another worktree. Removing or rotating the value
and restarting invalidates the old credential and its WebSocket tickets.

Normal credentials keep precedence. A rejected normal credential never falls
back to the reusable credential. OAuth exchanges create ordinary local bearer
or DPoP children with normal expiry and revocation. The reusable cookie expires
after 30 days.

## Portal users

When an operator configures Microsoft Entra ID, people sign in to the web
portal as themselves. Entra proves identity only. Access comes from the local
[user registry](../../apps/server/src/auth/UserRegistry.ts). A first sign-in
creates a pending user with no access, and an administrator approves them with
a role that maps to a fixed scope set. Users are keyed by tenant and object ID;
email and display name are labels and never authorize anything.

The local record is authoritative, so permissions are not frozen into the
browser credential. A [user-bound session](../../apps/server/src/auth/SessionStore.ts)
stores no scopes of its own. Session lookup already reads the session row on
every request; it joins the user in that same query and derives scopes from
the user's current status and role. A role change or disable therefore applies
to the next HTTP request at no extra cost, and to open sockets through the
mechanism above. A pending or disabled user stays authenticated with no scopes,
so the client can show why it sees nothing. User sessions expire after a fixed
lifetime, and their sockets close at expiry instead of outliving it.

The [sign-in flow](../../apps/server/src/auth/EntraSignIn.ts) builds its
redirect URI from the configured public URL, never from request or forwarded
headers. Behind a TLS-terminating platform those headers are whatever the
client sent.

With Entra on, a browser cookie session must belong to a user. Pairing and the
reusable dev credential can no longer create a browser session, and existing
pairing-derived browser sessions stop authenticating. Sign-out still revokes
such a session if its cookie is presented. The rule keys on the session method,
not on headers or client labels, which a client controls.

Pairing credentials and the token exchange keep working, because they are how
services such as Slack obtain bearer credentials. Their tokens are not bound to
a user, so a user must not be able to mint one. It would outlive their access.
With Entra on, the [pairing route](../../apps/server/src/auth/http.ts) refuses
user-bound sessions and startup prints no administrator pairing token. A service session with `access:write`
can still mint them; Slack's credential rotation depends on that. With users
unable to mint, every such session descends from the host CLI. T3 Connect is a
separate path: once an environment is linked, the linked cloud account obtains
pairing credentials through the relay without any environment session. An
environment that must admit only Entra users must not be linked.

Changing a user's access, including revoking their sessions, needs
`access:write` and a session that is itself a user, so the audit log can name
who made the change. The registry, not the transport, refuses to remove the
last active administrator; the host CLI is the recovery path.

Roles are scope sets, and only Reader restricts what someone can do. An
Operator holds `terminal:operate` and runs agents, both as the server's OS
user, so they can reach the host CLI and the state directory and are
effectively as trusted as an Administrator. Reader is for people who direct
agents without reading code: it holds `orchestration:read` alone, so threads,
diffs and plans are visible but file contents, searches and terminal output
are not. Those RPCs need `filesystem:read` or `terminal:read`, which only
pairing credentials grant; such a session is still confined, see the
filesystem boundary below.

Server settings reach every session, Readers included, so a secret the server
only uses must never be in what clients receive.
[`redactServerSettingsForClient`](../../apps/server/src/serverSettings.ts)
replaces each stored secret with `REDACTED_SECRET`, and an update that echoes
the marker back keeps the saved value. Provider config secrets are found from
the driver schema: a field with the `password` form control is redacted in
`providers.*` and in every `providerInstances[*].config`. A new secret field
outside a provider schema needs its own redaction.

## The environment is the filesystem boundary

For a session that can operate, projects are organizational boundaries, not
filesystem sandboxes. Such a session runs agents as the server account, so
`filesystem:read` permits reading files that account can read, including
absolute paths outside a project. This lets clients display artifacts that an
agent writes in a temporary directory. Relative paths and writes still follow
the [workspace path rules](../../apps/server/src/workspace/WorkspaceFileSystem.ts).

A session without `orchestration:operate` is confined, whatever else it holds.
Every RPC that reads at a client-named path or `cwd` (file reads, listings,
search, asset URLs, VCS status and refs) first passes it through
[WorkspaceReadAccess](../../apps/server/src/workspace/WorkspaceReadAccess.ts),
which admits only paths that, symlinks resolved, lie inside an active project's
root or one of its threads' worktrees. The state directory is never admitted,
and neither is anything under a root that contains it. A new RPC that takes a
path or `cwd` from the client must go through the same check, or a read-only
session can read the host through it. Browsing host folders to pick a project needs
`orchestration:operate` outright.

Signed asset URLs are bearer credentials. A URL for media on the host grants
access to one canonical file and its device/inode identity, not its containing directory.
[Asset access](../../apps/server/src/assets/AssetAccess.ts) rechecks the opened
file's identity when serving it, so atomic replacement requires a new URL while
editing the same file in place does not. An HTML file authorized this way cannot
load sibling assets; directory-scoped workspace previews are a separate grant.
Clients should share the authored file reference so they do not disclose the
temporary URL's credential. `filesystem:read` is checked when the URL is minted,
not when it is served: a URL issued before the grant was revoked keeps working
until it expires, and it is not bound to the session that minted it.

Host videos can change in place. Their [HTTP
responses](../../apps/server/src/http.ts) omit cache validators because file
metadata cannot prove byte-for-byte identity for `If-Range`. Adding weak
validators would turn native-player seeks into full downloads.
