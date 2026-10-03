# Environment authentication

The environment issues its own sessions and enforces their capabilities. Cloud identity and relay
credentials belong to a separate trust boundary, described in [T3 Connect](./06_t3-connect.md). A relay
token is never an environment login. See [SECURITY.md](../../SECURITY.md) for the overall threat
model.

## Scoped sessions and delegation

- **Narrowing only.** Pairing delegates a set of scopes. Exchanging a bootstrap credential can
  narrow a grant, never widen it. Client labels and device metadata have no authorization role.
- **`access:write` hands out what the session holds and revokes anything.** Every route that
  returns a credential to the caller requires `access:write` and every scope that credential
  carries: a pairing link, an MCP sign-in approval, a link code from a linked environment, and a
  guest link (which reads a thread). Revoking is not capped by the caller's scopes. Admitting a
  T3 Connect device is not delegation; see [T3 Connect](./06_t3-connect.md).
- **Why the default grant includes management scopes.** `terminal:operate` and
  `orchestration:operate` already grant OS-user execution (which can invoke `t3 auth session issue`),
  so withholding access or relay management from the default grant would not be a real boundary.
  Narrower clients receive explicit scopes.
- **No recoverable secrets in read models.** Only the creation response returns a raw pairing
  credential; access listings expose metadata only.
- **DPoP binding.** Browser cookies, bearer tokens, and DPoP tokens share the scoped session model.
  DPoP binds tokens to a client proof key; an invalid proof must fail rather than fall back to
  bearer auth. Plain paired DPoP sessions renew in place so live sockets and Sharing & access rows
  stay stable; T3 Connect, CLI, and desktop sessions never self-renew so revoking/unlinking cuts
  them off.
- **WebSocket tickets and per-RPC authorization.** Bearer and DPoP clients mint short-lived tickets
  over authenticated HTTP so long-lived tokens never appear in socket URLs. DPoP RPC tickets stay
  proof-key bound at upgrade. A successful handshake grants no extra authority: every RPC declares
  and checks its required scope in [`RpcAuthorization.ts`](../../apps/server/src/auth/RpcAuthorization.ts).
- **Secret references need `providers:manage`.** A request that names a secret for the server to
  read needs `providers:manage` on top of its method's scope, whether the reference is saved in
  settings or used once, as in a secret request answered with a reference. Typed values need only
  the method's scope. Clients hide the secret provider picker from sessions without it.
- **Project scripts need `orchestration:operate`.** The host runs a saved project script itself,
  on worktree creation and on settle, so saving one needs `orchestration:operate` on top of
  `settings:write`, whether it arrives in a settings patch or a project update.
- **Backward-compatible scope evolution.** Token exchange intersects requested scopes with the
  pairing grant, dropping retired/unknown names and failing before consuming a link if none remain.
  Stored grants are never expanded when scopes split. Auth responses preserve legacy `scopes`
  alongside exact `permissions` so older clients and servers stay compatible.

## Non-standard principals

- **Guest links are not sessions.** [GuestShareService](../../apps/server/src/guest/GuestShareService.ts)
  issues HMAC tokens bound to one share in the thread projection—never `SessionStore` rows—so no
  RPC, WebSocket, or MCP route can accept one. Closing, replacing, or archiving the share revokes
  every token. Guest routes also require T3 Connect to still serve the link's hostname (never rely
  on the request `Host` header alone).
- **MCP clients (`mcp-client`) are a separate audience.** Outside agents authenticate on `/mcp` via
  PKCE OAuth ([McpOAuth](../../apps/server/src/auth/McpOAuth.ts)), with stateless client
  registration so unauthenticated callers cannot grow server state. Users grant read-only access or
  a runtime-mode ceiling rather than raw scopes. Every non-`/mcp` HTTP and WebSocket route rejects
  `mcp-client` sessions (except the read-only thread relay and client-pairing routes restricted to
  [peer links](./05_remote.md#peer-links)). Every MCP tool must statically declare its access level in
  [`McpToolAccess.ts`](../../apps/server/src/mcp/McpToolAccess.ts), and thread-only tools must still
  refuse outside callers in handlers—hiding from tool listings is only discovery. A workflow run
  picks its own modes, so only a caller at the broadest mode a thread may run in here (full access,
  or an administrator's ceiling below it) can start or change runs, change what workflows store, or
  read webhook paths. Narrower callers can still read runs.
- **A project's worktree layout commands run only as a person approved them.** The commands come
  from the project folder's `t3.json` and run as the server's OS user, so each runs only after a
  client session holding `terminal:operate` approved its exact text for that project.
  [`TaskFolders`](../../apps/server/src/workspace/TaskFolders.ts) is the only place they run and
  checks the approval, managed policy, and who asked at every run. Recording an approval is a
  client RPC only: `t3code/no-layout-command-approval-writes` keeps the write side out of every
  other module, MCP tools included. For an agent's own worktree request, a thread below Full access
  gets neither these commands nor the project's setup script, approved or not. The asking thread's
  modes are read when each is about to run, a thread recorded above the administrator's
  `maxRuntimeMode` is not in Full access, and neither is an asking thread that can no longer be
  read. A command that waited for another one's turn is checked again, who asked, file and
  approval, before it starts; one refused then ran nothing, so the project's `remove` does not run
  for it either.
- **Peer-link client pairing.** Only a full-access peer link may mint a one-time client pairing on
  the linked environment (since full-access agents can already run `t3 auth pairing create`). The
  linked side enforces this itself, and the operation stays a human-triggered RPC/HTTP route rather
  than an MCP tool. The same route mints a code that links another environment at a chosen access
  level, and the linking side's RPC requires the caller to hold that level's scopes.

### Reusable dev credential

Web development servers can accept a fixed `T3CODE_DEV_AUTH_TOKEN` across worktrees and ports on one
hostname (see the [development runbook](../operations/00_development.md#reusable-dev-credential)). It
grants administrative access and is ignored by desktop and non-development servers.

Each environment hashes the value into its own database record and keeps independent SQLite state,
signing keys, and revocation state. Normal credentials always take precedence: a rejected normal
credential never falls back to the reusable dev credential.

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
mechanism below. A pending or disabled user stays authenticated with no scopes,
so the client can show why it sees nothing. User sessions expire after a fixed
lifetime, and their sockets close at expiry instead of outliving it.

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

The [sign-in flow](../../apps/server/src/auth/EntraSignIn.ts) builds its
redirect URI from the configured public URL, never from request or forwarded
headers. Behind a TLS-terminating platform those headers are whatever the
client sent.

The callback path is configurable so the redirect URI can follow an
organization's app registration convention. A path outside `/api` still reaches
the server because the router tries static routes before the `*` static and
SPA fallback. Under `vp run dev` it does not: Vite proxies only the
[dev-proxied prefixes](../../packages/shared/src/devProxy.ts), so a custom
callback path outside them is answered by Vite with the SPA. Leave it unset in
dev.

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
only uses must never be in what clients receive. A settings schema field marked with
`secretSetting` is moved to the secret store and redacted by
[`redactServerSettingsForClient`](../../apps/server/src/serverSettings.ts); an
update that echoes the marker back keeps the saved value. Secret fields are found
from the schema in
[`settingsSecrets.ts`](../../apps/server/src/settingsSecrets.ts), so a new
credential needs that annotation, and a new driver needs an entry there.

## The environment is the filesystem boundary

For a session that can operate, projects are organizational boundaries, not filesystem sandboxes.
`filesystem:read` permits reading
any file the server's OS user can read (for example, artifacts an agent writes in a temp directory);
relative paths and writes remain constrained by
[`WorkspaceFileSystem.ts`](../../apps/server/src/workspace/WorkspaceFileSystem.ts).

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

Signed asset URLs are bearer credentials for a single canonical file, rechecked by device/inode
identity on serve ([`AssetAccess.ts`](../../apps/server/src/assets/AssetAccess.ts)). They never
grant access to sibling files, and because `filesystem:read` is checked only at mint time, an issued
URL remains valid until it expires even if the session or grant is revoked.
