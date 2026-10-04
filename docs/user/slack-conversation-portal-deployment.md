# Deploying the Slack conversation portal

This deployment serves the T3 web client at a public HTTPS address, so links that Slack sends open
the conversation in a browser. People sign in with their Microsoft Entra ID work account. Entra only
proves who someone is. T3 keeps its own list of users and decides who gets in and what each person
may do.

A first sign-in creates a pending user with no access until an administrator approves them.
Disabling someone or changing their role takes effect on their next request, and open browser tabs
reconnect with the new access.

Every approved user works in one shared environment and sees all of its projects and
conversations. Slack App Home follows the same boundary and lists active conversations across every
project. Do not install the Slack app in a workspace whose members should only see one project, and
use a dedicated T3 environment and provider account when this portal should not touch other work.

```text
browser -> hosting platform (TLS, WebSocket) -> T3 private listener
   |
   +-- signs in with Microsoft Entra ID; T3 verifies the result itself

Slack daemon -> T3_HTTP_URL   (T3 private listener, its own service credential)
             -> T3_PUBLIC_URL (public address used in links sent to users)
```

## 1. Register the Entra application

In the Microsoft Entra admin center, open **App registrations → New registration**:

- **Supported account types**: accounts in this organizational directory only (single tenant).
- **Redirect URI**: platform **Web**, value `<public URL>/api/auth/entra/callback`, for example
  `https://t3.example.com/api/auth/entra/callback`. It must use the same origin as
  `T3CODE_PUBLIC_URL` below. If your organization registers a different path, such as
  `/auth/callback`, register that and set `T3CODE_ENTRA_CALLBACK_PATH` to the same path.

Then, on the registration:

- Under **Certificates & secrets**, create a client secret and copy its value. Note its expiry date;
  sign-in stops working when it expires.
- From **Overview**, copy the **Directory (tenant) ID** and the **Application (client) ID**.

T3 asks only for the standard sign-in permissions (`openid`, `profile`, `email`). Depending on your
tenant's consent settings, an administrator may need to grant consent for them once.

## 2. Configure T3

Set all four variables in the T3 service's environment. T3 refuses to start if only some are set.

| Variable                     | Value                                                                  |
| ---------------------------- | ---------------------------------------------------------------------- |
| `T3CODE_ENTRA_TENANT_ID`     | Directory (tenant) ID                                                  |
| `T3CODE_ENTRA_CLIENT_ID`     | Application (client) ID                                                |
| `T3CODE_ENTRA_CLIENT_SECRET` | Client secret value                                                    |
| `T3CODE_PUBLIC_URL`          | Public HTTPS origin with no path, for example `https://t3.example.com` |

Optionally, set `T3CODE_ENTRA_CALLBACK_PATH` to the path of the registered redirect URI when it is
not `/api/auth/entra/callback`, for example `/auth/callback`. It needs the four variables above. T3
refuses to start if the path has a query, fragment, empty or `..` segments, or overlaps a path T3
already serves, such as `/api`, `/ws`, `/oauth`, `/.well-known`, `/mcp`, or an app page like
`/pair` or `/settings`.

Keep the client secret in the service's secret store or an environment file readable only by the
service account, never in a repository or unit file.

Start T3 on a private listener that the hosting platform can reach, using an explicit T3 home so
the host commands below operate on the same state:

```sh
npx t3@latest serve --base-dir /srv/t3 --host <private address> --port 3773 --no-browser
```

With Entra sign-in on, startup prints the sign-in address and no pairing token. Pairing links do
not work as a browser login on this server.

## 3. Put the hosting platform in front

The hosting platform is the only public entry point. It must:

- terminate TLS for the public address and forward plain HTTP to T3's listener;
- forward WebSocket upgrades on every path, with query strings unchanged. The app's live connection
  uses `/ws`, and device streams use paths under `/api/device-hub/`;
- pass cookies and responses through unchanged. T3 sets its own HttpOnly session cookie, marked
  `Secure` because the public URL is HTTPS;
- forward webhook requests under `/api/hooks/` with method, body, and headers unchanged. Signature
  checks run over the exact request bytes. These requests carry no session: the per-hook token in
  the URL and the optional signing secret are the credential, and Entra sign-in does not apply;
- keep T3's listener unreachable except through the platform, so browsers always use TLS and the
  platform's rate limits and logging apply to every request.

The platform does not add credentials or identity headers. T3 ignores forwarded headers when
building sign-in redirects and always uses `T3CODE_PUBLIC_URL`.

## 4. Provision the first administrator

Nobody has access until an administrator exists. Create the first one from the T3 host. Find the
person's **Object ID** in the Entra admin center under **Users**, then run:

```sh
npx t3@latest auth user provision-admin --base-dir /srv/t3 \
  --tenant-id <tenant ID> --object-id <object ID>
```

This works before the person's first sign-in, whether or not the server is running. Run it with the
same `T3CODE_ENTRA_*` variables as the server, and it warns when the tenant ID is not the configured
tenant; such a user could never sign in. `npx t3@latest auth user list --base-dir /srv/t3` shows
every user with their status and role.

The administrator can now sign in at the public URL.

## 5. Approve users and choose roles

When someone signs in for the first time, they see that their account is awaiting approval. An
administrator approves them in **Settings → Users**, where pending users are listed first. Check the
object ID shown for each user before approving. The name and email come from the person's own
directory profile and are only labels.

| Role          | What it allows                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Reader        | See every project and conversation, and read the files in project folders, but start or change nothing                                |
| Operator      | Everything a Reader can do, plus start and steer agents, change settings and providers, use terminals, and run source-control actions |
| Administrator | Everything an Operator can do, plus manage users, client sessions, and T3 Connect                                                     |

**Operators are effectively administrators.** Terminals and agents run as the server's operating
system user. That account can run the host commands on this page and read T3's state directory, so
an Operator can make themselves an administrator. Give Operator only to people you would trust as
administrators.

**Readers see project files only.** A Reader can open, list and search files inside a project's
folder and its conversations' worktrees, and nothing else on the host. Links that point outside
those folders are refused. T3's state directory, where provider and T3 Connect credentials are
stored, is never readable by a Reader. A project whose folder contains the state directory, such as
one opened at the home directory, shows Readers its conversations but not the files in that folder.
Readers can see provider settings, but not saved API keys, passwords, tokens or sensitive
environment variables; T3 never sends those to a browser. Provider environment variables that are
not marked sensitive are visible to every signed-in user, so mark any that hold a secret as
sensitive.

From **Settings → Users** an administrator can also change a role, disable or re-enable a user, and
revoke a user's sessions. T3 refuses to disable or demote the last active administrator. A sign-in
lasts 12 hours; after that the person signs in again.

## 6. Issue the Slack daemon's service credential

Service credentials are not tied to a user and do not use Entra sign-in. Issue the Slack daemon's
credential from the T3 host by following
[Bootstrap narrow credentials](../operations/slack-ingress.md#bootstrap-narrow-credentials); its
rotation job renews it automatically. While Entra sign-in is on, signed-in users, administrators
included, cannot create pairing links from the web app, so service credentials always start on the
host.

Keep Slack's API traffic on the private listener:

```text
T3_HTTP_URL=http://<private address>:3773
T3_PUBLIC_URL=https://t3.example.com
T3_BEARER_CREDENTIAL_FILE=/run/secrets/t3-slack-bearer
```

The Slack daemon uses `T3_PUBLIC_URL` only to build the links it sends to people.

## 7. Verify the deployment

1. `curl --silent https://t3.example.com/api/auth/session | jq .auth.entraSignIn` prints `true`.
2. In a private browser window, open the public URL. It sends you to Microsoft sign-in and back. As
   the provisioned administrator you see **Settings → Users**.
3. Sign in with another account. It shows the awaiting-approval screen until you approve it.
4. Signed out, open a link that Slack generated. After sign-in it lands on that conversation, and a
   follow-up turn works.
5. From another machine, confirm T3's listener port is not reachable directly.

## Recovery

If no administrator can sign in, for example because the last one left the organization, provision
another from the T3 host with `auth user provision-admin`. It also re-enables or promotes an
existing user.

If sign-in fails for everyone, check the server log for `Entra sign-in failed`, which includes the
reason and Entra's error code. An expired client secret is the usual cause. Create a new secret,
update `T3CODE_ENTRA_CLIENT_SECRET`, and restart T3. Host commands under `npx t3@latest auth` keep
working while sign-in is broken.

## T3 Connect bypasses Entra sign-in

If this environment is linked to T3 Connect, the linked T3 Connect account can reach it without
Entra sign-in. If the portal must admit only Entra users, do not link it. To remove an existing link,
run `npx t3@latest connect unlink` on the host and deregister the environment from your T3 Connect
account.

## Moving from the nginx deployment

Earlier versions of this guide put T3 behind nginx, which injected one shared portal credential for
every visitor. To move to Entra sign-in:

1. Register the Entra application and provision the first administrator, as in steps 1 and 4.
2. Set the four `T3CODE_*` variables and restart T3. The Slack daemon keeps working. Sign-in cannot
   work through the old nginx configuration, because it strips cookies.
3. Route the public address through the hosting platform instead of nginx, as in step 3. The public
   address must match `T3CODE_PUBLIC_URL` and the registered redirect URI.
4. Verify sign-in, as in step 7.
5. Stop nginx and remove its T3 configuration and the secret file holding the portal credential.
6. Revoke the old shared portal credential. Find its session by its `conversation-portal-*` label
   with `npx t3@latest auth session list --base-dir /srv/t3 --json`, then run
   `npx t3@latest auth session revoke --base-dir /srv/t3 <session ID>`.
7. Approve people in **Settings → Users** as they sign in.

Browser sessions that came from pairing links stop working as soon as Entra sign-in is on.
