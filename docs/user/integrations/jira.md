# Jira

T3 Code reads your Jira Cloud site so you can see issues next to your threads. You
can browse issues by saved filter, open an issue, link it to a thread, and start a
thread from it.

This first version is read-only. T3 Code never changes an issue. Agents that should
update Jira use their own credentials, described in [Agents that write to Jira](#agents-that-write-to-jira).

## What you can do

- Browse issues on the Issues page, using a Jira saved filter as the view.
- Open an issue to see its summary, status, assignee, sprint, story points,
  description, and comments. The detail also lists the pull requests and threads
  that mention the issue.
- Link an issue to a thread.
- Start a new thread from an issue.

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

We recommend an Atlassian service account with a scoped API token. Give it at least
read access to work items and users, for example the `read:jira-work` and
`read:jira-user` scopes.

Scoped tokens cannot use Jira's Agile API, which covers boards and sprint endpoints.
They also cannot use the Development panel, Automation, or Dashboards. T3 Code does
not need any of these. It reads sprints from each issue's sprint field, and you can
build sprint views as saved filters.

A classic token is a personal API token paired with the account's email. It reads as
that person, so it sees everything that person can see.

## Who sees what

Every read uses the reader identity. Anyone with access to your T3 Code server can
read whatever that identity can read in Jira, regardless of their own Jira
permissions. Pick the reader's Jira permissions with that in mind, and use a
dedicated service account if you want to limit what the team can see.

## Views from saved filters

The Issues page shows one Jira saved filter at a time. Pick any filter the reader
identity can see. Favourites come first.

T3 Code reads the filter's name and JQL from Jira each time, so editing the filter in
Jira changes the view. To mirror a board, use the board's filter.

Issues are grouped by status category, which is To Do, In Progress, or Done. Status
names differ between projects, so the category is the only grouping that works
across them. You can narrow the list by assignee, priority, and issue type. For a
one-off query, use ad-hoc JQL.

Sprint views are saved filters too:

```text
project = ABC AND sprint in openSprints() ORDER BY Rank
project = ABC AND sprint in futureSprints()
project = ABC AND sprint in closedSprints()
```

## Link issues to threads

Link an issue from the thread's details or the command palette. Enter the key, such as
`ABC-123`, or the issue's browse URL.

T3 Code also links automatically. If a thread's branch name contains an issue key,
for example `feature/abc-123-login`, the link appears within about a minute. If you
unlink an automatic link, it stays unlinked.

Agents in a thread can manage links with T3 Code's MCP tools `link_jira_issue`,
`unlink_jira_issue`, and `list_thread_jira_issues`.

Linked issues refresh their summary and status every few minutes. An issue's detail
lists pull requests whose branch or title contains its key. Only pull requests
linked to threads in T3 Code are considered.

Choosing "Start thread from issue" on the Issues page fills a new thread's message
with the issue and suggests a branch name containing the key. If the thread's branch
ends up carrying the key, the thread links itself; otherwise link it by hand.

## Agents that write to Jira

T3 Code's connection is read-only. An agent that should comment on or transition
issues uses the `jtk` CLI with its own credentials. Set `JIRA_*` environment
variables on the provider instance's environment in provider settings. Those
credentials are separate from the ones above, so the agent's write access does not
depend on the reader identity.
