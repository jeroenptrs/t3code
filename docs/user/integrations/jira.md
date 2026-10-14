# Jira

T3 Code reads your Jira Cloud site so you can see issues next to your threads. You
can browse issues by saved filter, open an issue, link it to a thread, and start a
thread from it.

T3 Code changes Jira as you, with your own token. That covers changes you approve
after an agent proposes them and the comments and moves you make yourself. The one
thing the server writes with its own identity is a link on the Jira issue back to a
linked thread. Everything else is read-only. See
[Agents that write to Jira](#agents-that-write-to-jira) and
[Link back to the thread](#link-back-to-the-thread).

## What you can do

- Browse issues on the Issues page, using a Jira saved filter as the view.
- Open an issue to see its summary, status, assignee, sprint, story points,
  description, and comments. The detail also lists the pull requests and threads
  that mention the issue.
- Link an issue to a thread.
- Start a new thread from an issue.
- Approve issues, comments, and transitions that an agent proposes.
- Post a comment or move an issue to another status from the issue's detail. You act
  as yourself, so this needs your [personal Jira token](#use-your-own-jira-token) for
  the issue's site and permission to operate the environment. Readers cannot. A move
  offers only the statuses Jira currently allows for the issue.
- Let an agent [watch a linked issue](#watch-linked-issues) and pick up where it
  left off when the issue changes.

## Set up the connection

Configuration is server-side. Set the variables below where the T3 Code server
runs, then restart it. Tokens stay on the server and are never sent to clients.

`T3CODE_JIRA_IDENTITIES` lists the Jira identities the server can use, separated by
commas. Names use lowercase letters, digits, and `-`, for example `reader` or
`reader,planner`. When it is unset, Jira is off.

Each identity needs its own variables. In them, `NAME` is the identity name in
uppercase with `-` replaced by `_`. An identity called `team-reader` uses
`T3CODE_JIRA_TEAM_READER_SITE`.

| Variable                      | Purpose                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `T3CODE_JIRA_<NAME>_SITE`     | Your site, such as `acme.atlassian.net` or its full `https://` URL |
| `T3CODE_JIRA_<NAME>_TOKEN`    | The API token                                                      |
| `T3CODE_JIRA_<NAME>_CLOUD_ID` | Required for a scoped token                                        |
| `T3CODE_JIRA_<NAME>_EMAIL`    | Required for a classic token. Set it to the account's email        |

If `EMAIL` is set, the identity uses a classic token. Otherwise `CLOUD_ID` is
required and the token is treated as scoped. Your cloud id is shown at
`https://<your-site>/_edge/tenant_info`.

A service account with a scoped token:

```sh
T3CODE_JIRA_IDENTITIES=reader
T3CODE_JIRA_READER_SITE=https://acme.atlassian.net
T3CODE_JIRA_READER_TOKEN=<scoped API token>
T3CODE_JIRA_READER_CLOUD_ID=<cloud id>
```

A classic personal token:

```sh
T3CODE_JIRA_IDENTITIES=reader
T3CODE_JIRA_READER_SITE=acme.atlassian.net
T3CODE_JIRA_READER_TOKEN=<API token>
T3CODE_JIRA_READER_EMAIL=you@acme.com
```

`T3CODE_JIRA_READER` names the identity that serves every read the UI makes. It
defaults to the first identity in the list.

If a variable is missing or inconsistent, the server refuses to start and the error
names the variable.

## Choose a token

We recommend an Atlassian service account with a scoped API token. For reading, give
it the `read:jira-work` and `read:jira-user` scopes. Add `write:jira-work` if you want
T3 Code to put [thread links](#link-back-to-the-thread) on issues.

Scoped tokens cannot use Jira's Agile API, which covers boards and sprint endpoints.
They also cannot use the Development panel, Automation, or Dashboards. T3 Code does
not need any of these. It reads sprints from each issue's sprint field, and you can
build sprint views as saved filters.

A classic token is a personal API token paired with the account's email. It reads as
that person, so it sees everything that person can see.

Jira translates status and issue type names into the language of the account that
reads them. T3 Code asks Jira for English names, but some names can still follow the
account's language. If you see names in another language, set the language of the
service account, or of your own account, to English in its Atlassian profile.

## Who sees what

By default, every read uses the reader identity. Anyone with access to your T3 Code
server can read whatever that identity can read in Jira, regardless of their own Jira
permissions. Pick the reader's Jira permissions with that in mind, and use a
dedicated service account if you want to limit what the team can see.

When the server uses organisation sign-in, each signed-in user can store a personal
Jira token instead. While it is stored, your Issues page and issue details read Jira
as you, so you see what your own Jira account can see, and changes you approve are
made as you. So are the comments and moves you make from an issue's detail. Everyone
without a token still reads as the reader identity and cannot approve changes,
comment, or move issues.

Agents never receive your token. Background work, such as linking branches,
refreshing linked issues, watching issues, and writing thread links, always uses the
server's identities.

## Use your own Jira token

1. Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens>.
   A scoped token needs `read:jira-work`, `read:jira-user`, and `write:jira-work`.
   A classic token also works.
2. In T3 Code, open Settings → Account and enter the email of your Atlassian account
   and the token.

The token needs `write:jira-work` for approvals, comments, and moves.

T3 Code checks the token with Jira before saving it. A rejected token is not saved.
The token can only be for a site the server is configured for. The server stores it
and never sends it back to clients.

If Jira later rejects the stored token, the Issues page says so and points you to
Settings → Account. There you can test, replace, or remove the token. Without a
token, you read as the reader identity again.

## Views from saved filters

The Issues page shows one Jira saved filter at a time. Pick any filter you can see.
Favourites come first.

T3 Code reads the filter's name and JQL from Jira each time, so editing the filter in
Jira changes the view. To mirror a board, use the board's filter.

Issues are grouped by status category, which is To Do, In Progress, or Done. Status
names differ between projects, so the category is the only grouping that works
across them. You can narrow the list by assignee, priority, issue type, status, and
sprint, and clear the filters again. For a one-off query, use ad-hoc JQL.

Sprint views are saved filters too:

```text
project = ABC AND sprint in openSprints() ORDER BY Rank
project = ABC AND sprint in futureSprints()
project = ABC AND sprint in closedSprints()
```

## Link issues to threads

Link an issue from the thread's details or the command palette. Enter the key, such as
`ABC-123`, or the issue's browse URL.

T3 Code also links automatically. If a thread's branch name contains the key of an
issue that exists, for example `feature/abc-123-login`, the link appears shortly after
the branch is set. When a branch contains several keys, the first one counts. Once you
unlink an issue, the branch does not link it again.

When Jira is configured, agents in a thread are told about T3 Code's link tools
`link_jira_issue`, `unlink_jira_issue`, `list_thread_jira_issues`, `watch_jira_issue`
and `unwatch_jira_issue`, and can use them to manage links and watches.

Linked issues refresh their summary and status every few minutes. An issue's detail
lists pull requests whose branch or title contains its key. Only pull requests
linked to threads in T3 Code are considered.

Choosing "Start thread from issue" on the Issues page fills a new thread's message
with the issue. When the thread starts in a new worktree, the worktree's branch is
named after the issue and contains its key, so the thread links itself. If a branch
with that name already exists, T3 Code adds a numbered suffix. Clear the name before
you send to let T3 Code name the branch as usual, then link the issue by hand if the
branch lacks the key. A thread that runs locally only gets the suggested branch name
in its message.

## Link back to the thread

When a thread links an issue and the server has a public URL (`T3CODE_PUBLIC_URL`,
used with organisation sign-in), T3 Code adds a link on the Jira issue back to the
thread. It removes the link when the thread unlinks the issue or is archived or
deleted.

The server writes this link with its own identity for that site, which needs
write access (`write:jira-work` for a scoped token). Without write access, T3 Code
skips the link without an error. This is the only thing the server writes on its own.

## Watch linked issues

A thread can watch a linked issue. Use the eye on the issue's row in the thread's
Jira section, or ask the agent to watch it and it calls `watch_jira_issue`. The
agent stops watching with `unwatch_jira_issue`.

The server checks a watched issue every two minutes, with the server's identity, and
wakes the agent when someone else comments, the issue moves to another status
category, or its assignee changes. Comments T3 Code posts, for you or for an approved
proposal, do not wake it, and neither do comments by any account listed in
`T3CODE_JIRA_IDENTITIES`. List the Jira account your agents comment with through jtk
there too, so an agent's own comments do not wake it. A watching thread counts as
working between wakes, like one watching a pull request.

A watch ends after ten wakes in a row that bring only comments. It also ends when you
unlink the issue, when the reader can no longer see it, or when the thread is stopped,
archived, or settles. Subagents cannot watch issues.

## Agents that write to Jira

An agent can propose creating issues, posting a comment, or moving an issue to
another status. The proposal appears as a card in the thread, and the thread shows
as waiting for you. You can edit the proposal, then approve or reject it. Nothing is
written until someone approves, whatever the thread's access mode, and the card
stays open after the agent's turn ends or the thread is stopped.

An approval writes to Jira with the approver's own personal token, so Jira records
the change as theirs. Add yours in Settings → Account before approving. T3 Code never
makes an approved change with a shared account. If an approval fails partway, for
example after creating some of the issues, approving again writes only what is
missing. An approval cut short by a server restart shows as failed, and the same
applies. Story points and sprint are set right after an issue is created, so they
work even when the project's create screen leaves them out. A transition is checked
again when you approve, and is refused if the issue no longer offers it.

An agent that should change Jira as itself uses the `jtk` CLI with its own
credentials. Set `JIRA_*` environment variables on the provider instance's
environment in provider settings. Those credentials are separate from the ones
above, so the agent's write access does not depend on the reader identity.

## Start a thread from Jira

A Jira Automation rule can start a thread when someone adds a label such as `t3` to
an issue. T3 Code receives the request through a webhook scheduled task, so Jira has
to reach your server. Atlassian's cloud can't see a private address, so use a public
URL: a [T3 Connect](../remote-access.md) tunnel or a server deployed with
`T3CODE_PUBLIC_URL`.

1. In **Settings → Scheduled tasks**, create a task with the **On webhook** schedule
   and copy its URL. See [Webhook automations](../project-settings.md#webhook-automations).
   Anyone with the URL can start runs, so keep it private. Jira's "Send web request"
   action can't sign requests, so the signature check doesn't apply here.
2. Write the prompt with placeholders for the request body:

   ```text
   Work on Jira issue {{body.issue.key}}: {{body.issue.summary}} ({{body.issue.url}}).
   Requested by {{body.actor}} in Jira. Link the issue to this thread with
   link_jira_issue, then plan the change and start on it.
   ```

3. In Jira, open **Project settings → Automation** and create a rule. Use the
   trigger **Field value changed** on Labels, or **Issue updated**, and add a
   condition that Labels contains `t3`.
4. Add the action **Send web request**. Paste the T3 Code URL, choose `POST`, set the
   body to **Custom data**, add the header `Content-Type: application/json`, and use
   this body:

   ```json
   {
     "issue": {
       "key": "{{issue.key}}",
       "summary": "{{issue.summary.jsonEncode}}",
       "url": "{{issue.url}}"
     },
     "actor": "{{initiator.displayName.jsonEncode}}"
   }
   ```

`jsonEncode` escapes quotes in the summary and name so the body stays valid JSON.
The agent links the issue with `link_jira_issue`, or the thread links itself when
its branch name contains the key. To start exactly one thread per label, add an
**Edit issue** action to the rule that removes the label afterwards.
