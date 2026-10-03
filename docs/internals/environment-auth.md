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
vocabulary gives these grants a familiar meaning, but the environment does not
implement a general-purpose OAuth authorization server.

Bearer and DPoP clients obtain short-lived WebSocket tickets through authenticated
HTTP so long-lived tokens stay out of socket URLs. Browser sessions can
authenticate the upgrade with their cookie. A successful handshake grants no
extra authority: [every RPC declares a required
scope](../../apps/server/src/auth/RpcAuthorization.ts), and the WebSocket RPC
group's `RpcScopeAuthorization` middleware checks it before any handler runs.

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
effectively as trusted as an Administrator. Reader also limits what someone can
read on the host; see the filesystem boundary below.

## The environment is the filesystem boundary

For a session that can operate, projects are organizational boundaries, not
filesystem sandboxes. Such a session runs agents as the server account, so
`orchestration:operate` also permits reading files that account can read,
including absolute paths outside a project. This lets clients display artifacts
that an agent writes in a temporary directory. Relative paths and writes still
follow the [workspace path rules](../../apps/server/src/workspace/WorkspaceFileSystem.ts).

A session without `orchestration:operate` is confined. Every RPC that reads at a
client-named path or `cwd` (file reads, listings, search, asset URLs, VCS status
and refs) first passes it through
[WorkspaceReadAccess](../../apps/server/src/workspace/WorkspaceReadAccess.ts),
which admits only paths that, symlinks resolved, lie inside an active project's
root or one of its threads' worktrees. The state directory is never admitted,
and neither is anything under a root that contains it. A new RPC that takes a
path or `cwd` from the client must go through the same check, or a Reader can
read the host through it. Browsing host folders to pick a project needs
`orchestration:operate` outright.

Signed asset URLs are bearer credentials. A URL for media on the host grants
access to one canonical file and its device/inode identity, not its containing directory.
[Asset access](../../apps/server/src/assets/AssetAccess.ts) rechecks the opened
file's identity when serving it, so atomic replacement requires a new URL while
editing the same file in place does not. An HTML file authorized this way cannot
load sibling assets; directory-scoped workspace previews are a separate grant.
Clients should share the authored file reference so they do not disclose the
temporary URL's credential.

Host videos can change in place. Their [HTTP
responses](../../apps/server/src/http.ts) omit cache validators because file
metadata cannot prove byte-for-byte identity for `If-Range`. Adding weak
validators would turn native-player seeks into full downloads.
