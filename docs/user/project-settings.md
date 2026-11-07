# Settings and project overrides

T3 Code separates **device preferences** (saved locally per browser/device, like Appearance and Confirmations) from **server settings** (stored on each environment, like Threads, Worktrees, and Source control).

## Scope and inheritance

Use the **"Applying settings for …"** selector at the top of Settings (web/desktop) or the header filter (mobile) to choose which **environment(s)** and **project** you are editing:

- **All environments**: Bulk-edits every currently connected environment (offline environments keep their values). Controls show **Mixed** where environments disagree.
- **Project scope**: Creates a project override for that setting without changing environment defaults. Settings that cannot be overridden appear read-only.
- **Inheritance order**: `Project override` → `Environment setting` → `t3.json` in the repo → `Built-in default`. Leave a setting on **Inherit** to defer to the next tier.
- Click the **layers icon** beside a server setting to inspect its inheritance chain, jump to overriding projects, or **Reset all** back to the environment default.
- **Per-project providers**: With a project selected in **Settings → Providers**, toggling a provider enables or disables it for that project only (in either direction). Running turns finish; no new turns start on a disabled provider.

## Pin and archive projects

- **Pin**: Pinned projects sort first in project pickers, the command palette, the sidebar filter, and mobile (`mod+shift+p` on a highlighted row, or **Settings → Projects**).
- **Archive**: Archive finished projects in **Settings → Projects** (mobile: **Settings → Projects → Organize**). Archived projects leave pickers while keeping their threads, settings, and files; unarchive anytime from Settings.
- Pinning or archiving a project that exists on multiple machines requires all of those machines to be connected.

## Project icons and multi-repo projects

- **Icons**: In **Settings → Projects**, set an icon, emoji, monogram, or image (applies across checkouts). Without one, T3 Code generates a two-character monogram (or single CJK character) from the project name.
- **Multiple repositories**: See [Projects with several repositories](./multi-repo-projects.md).

## Worktree settings

Configure worktrees in **Settings → Worktrees** (environment default or project override):

- **Branch naming**: Choose a static prefix (default `t3/`), model-selected semantic prefix (`feat/`, `fix/`), or custom instructions. Falls back to the temporary branch name if generation fails or collides.
- **Submodules** (under Advanced): Defaults to recursive checkout; set to **Top level only** or **Skip** (or `"worktreeSubmodules"` in `t3.json`) for repos with heavy nested submodules.
- **Sparse checkout**: Set `"worktreeSparsePatternsPath"` in `t3.json` to a repo-relative file of Git sparse-checkout patterns (non-cone syntax; requires Git 2.35+; enables `extensions.worktreeConfig`). Set Submodules to **Skip** if you don't want submodules initialized under excluded paths.
- **Worktree location** (per machine): Set an absolute path (e.g. `D:\worktrees` or `~/worktrees`) to store new worktrees elsewhere. Existing worktrees stay where they are; cleanup covers both folders.
- **Fast worktree checkout (macOS beta)**: Enable **Settings → Labs → Fast worktree checkout** (Git 2.42+) to clone new worktrees via APFS copy-on-write from a local cache. Falls back to normal checkout for cross-drive paths, sparse checkouts, or Git LFS/filter repos.

### Storage cleanup

Enable automatic cleanup in **Settings → Worktrees → Cleanup** (off by default; runs on startup, on change, and hourly). Projects can set **Automatic worktree cleanup** to **Inherit**, **Off**, or **Custom**.

- **Triggers**: Inactive days, days after settlement (`0` = next cleanup), merged PRs (including GitHub squash/rebase merges into the default branch), or settled/archived threads with no commits beyond the default branch.
- **Safety**: Active sessions and shared worktrees are never removed. **Keep worktrees with local changes** defaults to **Uncommitted changes** (protects tracked edits and untracked files; removes ignored files like `.env`/build output). Choose **Any local files** (also protects ignored files except `node_modules`) or **Edited tracked files** (protects tracked edits only).
- **Delete with deleted threads**: Enable **Delete worktrees with deleted threads** to automatically clean up safe worktrees once their last thread is deleted.
- **Scratch folders**: Inactive and settled rules also apply to [no-project scratch folders](./thread-sidebar.md#start-without-a-project) (skipped if they contain a Git repo or enabled scheduled task). Because scratch files aren't in Git, deleted files cannot be recovered.
- **Manual run**: Click **Delete now** to run rules immediately and inspect what was removed, kept, or orphaned (untracked folders are listed but never auto-deleted).
- **Captures and logs**: Browser captures and rotated logs have separate machine-wide retention periods.

## Keep the default branch current

Enable **Settings → Source control & issues → Automatically pull** to fast-forward clean default-branch checkouts from their configured upstream. Skips checkouts with local changes, untracked files, local commits, other branches, or no upstream.

## Triggers

A trigger starts work when something happens. It has a source, optional
filters, and a destination. Open **Settings → Triggers** to create triggers or
manage existing ones across your connected environments. Use the settings
filter to narrow the list by environment or project. Each trigger runs on the
environment you choose, using its project, model, and workspace settings.

You can edit, pause, resume, run immediately, or delete a trigger from the
list. A trigger whose source is an event, such as a webhook or a Jira change,
runs only when its event arrives, so it can't be run immediately. Leaving an
edited form asks before discarding unsaved changes.

### Schedule

A schedule runs the trigger at a time of day, once, or every interval. Choose
**Once** to run a trigger a single time at a date and time in your own time
zone. If the environment is offline then, the trigger runs when it is back.
Triggers saved without a zone follow the environment's time zone.

### Webhook

Choose **Webhook** as the source to run a trigger whenever another service
calls its URL, such as GitHub on a new pull request or a CI job that failed.
After you save the trigger, copy its URL from the editor. If the environment
uses a [T3 Connect](remote-access.md) managed tunnel, the URL is public. Without
one, a server deployed with a public URL (`T3CODE_PUBLIC_URL`, see
[the portal deployment](slack-conversation-portal-deployment.md)) builds the URL
on that address. Otherwise it works anywhere the environment itself is
reachable. **Rotate** replaces the URL and the old one stops working.

The prompt decides what the agent sees. Placeholders pull values out of the
request: `{{body.path}}` for a JSON or form field, `{{headers.name}}`,
`{{query.name}}`, `{{body}}` for the raw body, and `{{request}}` for everything.
For example, `Review this PR: {{body.pull_request.html_url}}` sends only the
pull request link. A placeholder with no value is left empty.

Each value reaches the agent wrapped in `<webhook-data-…>` tags and marked as
untrusted request data. This helps the agent tell it apart from your
instructions, but it doesn't guarantee the agent ignores what the text says.
Inside a value, every `$`, other currency sign and `@`, and a `/` that starts
a lone word, gets an invisible character after it, so mentions like `$skill`,
`@file` and `/command` don't act. Text copied from a value, such as an email
address or a command, carries that character too. Without a signature, anyone
with the URL can start a run with any content. A signature only proves which
service sent the request: a GitHub payload still carries text written by any
GitHub user.

For GitHub, turn on **Require signature**, keep the header
`x-hub-signature-256`, hex encoding and the `sha256=` prefix, and enter the
same secret in the repository's webhook settings with content type
`application/json`. Requests without a valid signature are rejected. Set this
up on desktop or web; mobile keeps an existing signature check but can't turn
one on.

To run only for some requests, add **Filters**. Each one tests a value named
like a placeholder, without the braces, such as `headers.x-github-event` equals
`pull_request` or `body.action` is one of `opened, reopened`. A trigger runs
only when every filter matches; other requests are answered normally, logged as
**Filtered** with the first filter that failed, and start nothing. Values
compare as text, and a value that is an object or a list only passes
**exists**. Separate **is one of** values with commas; a value can't contain
a comma or start or end with a space.

To suppress repeated deliveries, set a **Duplicate request key** template, such as
`{{headers.delivery-id}}`. The same key is ignored for seven days per trigger.
To combine a burst, set a **Coalesce key**, such as `{{body.id}}`, and a window
of 10–3600 seconds (120 by default). One run uses the latest body, headers,
and query when the window from the first delivery closes; later requests
do not extend it. Pending windows survive a server restart. Keys must contain
request placeholders; if any placeholder is missing, or the render is empty,
that key's rule is skipped. Clear the templates to turn dedupe off.

Duplicate and coalesced log entries share a limit of 10 per trigger per minute.
Additional deliveries are accepted without a log entry, and coalesced deliveries
always replace the persisted payload. Coalesced updates count toward a separate
60-per-minute validation limit; exceeding it receives HTTP 429.

On desktop and web, pick **Deliveries** from a trigger's menu to see recent
requests and the prompt each one produced.

If the environment is offline, the sender gets an error and nothing runs;
redeliver from the sender, such as GitHub's **Recent Deliveries**, once it is
back. To have T3 Connect keep requests instead, turn on **Hold webhooks while
offline** in **Settings → Sharing & access**. T3 Connect then stores requests to a
T3 Connect URL for up to 24 hours and delivers them when the environment
returns. Leave it off if you don't want request bodies stored outside your
machine. To skip requests that waited too long, set **Skip requests older
than** on the trigger.

### Jira change and GitLab change

**Jira** runs when a Jira issue changes status, labels, or assignee. **GitLab**
runs when a GitLab merge request opens, changes, merges, or closes, or when its
pipeline fails or passes.

These events come from the issues and merge requests T3 Code already keeps up
to date for linked threads, so a change shows up within a few minutes. An issue
or merge request that no thread links raises no events. For those, use a
[Jira query](#jira-query), [GitLab projects](#gitlab-projects), or a
[webhook](#webhook) source instead. The first time T3 Code sees an issue, it
only records it. A merge request that is already open the first time counts as
opened.

The event types are:

- Jira: `issue.status_changed`, `issue.labels_changed`, and
  `issue.assignee_changed`.
- GitLab: `merge_request.opened`, `merge_request.updated`,
  `merge_request.merged`, `merge_request.closed`, `pipeline.failed`, and
  `pipeline.passed`.

### Jira query

**Jira query** watches the issues a JQL query or a saved Jira filter returns,
whether or not a thread links them. Pick the site, enter the JQL or pick a
saved filter, and set how often to check: every 15 minutes by default, and at
most every 5 minutes.

T3 Code checks the query as the Jira identity configured for T3 Code on that
site, never as a person's own Jira account. The JQL or the saved filter must be
visible to that identity. A saved filter's current JQL applies on every check,
so editing the filter in Jira changes what the trigger watches.

When you save a trigger, turn it back on, or change its site or query, it
checks at once. Events come from the next check on, except as
[First check](#first-check) describes. A check reads up to 500 issues. If a check fails, the trigger
shows the error, and it tries again at the next interval.

The event types are:

- `issue.entered` when an issue starts matching the query, and `issue.left`
  when it stops matching.
- `issue.status_changed`, `issue.labels_changed`, and `issue.assignee_changed`.
- `issue.updated` when the priority, issue type, or summary changes, for each
  of those that a filter names.

Events carry the same fields as a Jira change, plus **Changed fields**, the
watched fields that changed, and **Query**, the JQL or the saved filter's name.

### GitLab projects

**GitLab projects** watches the merge requests and pipelines of project paths,
a group, or both on one GitLab host, whether or not a thread links them. Set
the interval the same way as for a Jira query.

T3 Code checks as the `glab` login on the environment for that host. If
`glab` has no login for the host, the trigger shows an error until you sign
in.

The first check raises no pipeline events. Later checks raise:

- `merge_request.opened`, `merge_request.updated`, `merge_request.merged`, and
  `merge_request.closed`.
- `pipeline.finished` when a pipeline finishes, with **Pipeline status**,
  **Pipeline URL**, and **Pipeline ref**.

Changing the projects or the group records the new set without raising
events. If you can add a webhook to the GitLab project, a
[webhook](#webhook) source reacts sooner than a check every few minutes.

### First check

When you create a Jira query or GitLab projects trigger, **First check acts on**
sets what its first check does. **Only changes after it**, the default, records
the issues or merge requests it finds and raises nothing for them. **Everything
it finds** raises `issue.entered` for each issue in the query, or
`merge_request.opened` for each open merge request, and those events go through
the trigger's filters like any other. The choice applies to the first check
only. Changing the query, the projects, or the group later records the new set
without raising events either way. GitLab projects triggers created before this
choice existed act on everything they find.

### Slack

**Slack** runs when the [Slack integration](integrations/slack.md) passes a
message to the environment. Its event type is `message`.

### Manual

**Manual** never runs on its own. It runs when you choose **Run now** or an
agent starts it.

### Filters

To run only for some events, add **Filters**. Each filter picks a field the
source sends, such as **Status** or **Labels**, a test, and a value. For
example, **Event type** equals `issue.status_changed` and **Status** equals
`In Progress` together run the trigger when an issue moves into In Progress. A
trigger runs only when every filter matches. Values compare as text. A list
field, such as **Labels** or **Added labels**, passes when any item matches.
For a list, **does not equal** passes only when no item equals the value, and
**exists** passes only when the list has an item. A field with no value, such
as **Assignee** on an unassigned issue, fails every test, **exists** included.
Separate **is one of** values with commas. Webhook filters test request values
instead, as described under [Webhook](#webhook).

The Jira, GitLab, Jira query, and GitLab projects sources also have **Act on**,
which picks the event types the trigger runs for. All types are on by default.
Turning some off saves an **Event type** is one of filter, and an existing
filter like that opens in **Act on**.

In the prompt, `{{event.<field>}}` inserts one field, such as `{{event.key}}`
or `{{event.summary}}`, and `{{event}}` inserts every field. Choosing a source
on a trigger with an empty prompt fills in a starting prompt for it. Event
values reach the agent wrapped and marked as untrusted data, the same way as
webhook values.

### Destination

Under **Destination**, choose where runs go. **New thread each run** keeps every
run separate. The two one-thread choices start a thread on the first run and post
later runs there: one continues the same conversation, the other starts each run
in a fresh session that doesn't see earlier runs, so the thread stays readable
without the agent's context growing. To move a one-thread trigger, pick another
thread in its project under **Destination**. Moving such a trigger to another
project starts a new thread there on its next run.

Deleting a thread also deletes triggers that post into that thread. Triggers
that start a new thread on each run survive deletion of their previous threads.
An archived thread refuses messages, so a trigger that posts into one stays on and fails
each run until you unarchive the thread or pick another destination. To set a trigger's thread
aside without breaking it, settle the thread; see [Settle or archive](thread-sidebar.md#settle-or-archive).

**Work item in factory** creates a work item in one of the project's
[factories](factories.md) for each run instead of running the prompt. The
factory's Foreman routes it like any other work item. A Jira, GitLab, or Slack
event puts its fields on the work item. A webhook puts its filled-in prompt
there, and a schedule or a manual run puts the trigger's prompt there. Event
values reach the Foreman wrapped and marked as untrusted data, the same way as
placeholders in a prompt.

On a factory's page, **Add trigger** opens the trigger form with that factory
as the destination and attaches the new trigger to the factory. Deleting a
factory removes its definition and its work items, and keeps its triggers. A
trigger that still targets the deleted factory shows an error on its next run.

### Triggers on mobile

Mobile edits the same triggers, with these differences:

- A new fixed-time schedule uses your phone's time zone. To pick a different
  zone, edit the trigger in the web or desktop app.
- A webhook keeps an existing signature check, but you can't turn one on.
- A Jira query takes JQL. A saved filter picked on web or desktop shows and is
  kept, but you can't pick one.
- **Destination** offers the same choices, **Work item in factory** included.

### Trigger templates

A trigger template is a saved trigger: a source, filters, and a prompt, with
placeholders such as `{{status}}` that you fill in when you use it. Each
template is a file in the project at `.t3/triggers/<name>.md`, so you can commit
it and share it with everyone who works in the repository.

Templates appear under **Trigger templates** below the trigger list. Pick a
project to see its templates. Operators can see and use templates. Only
administrators can create, edit, or delete them.

To use a template, choose **Use**. Fill in its values and choose **Create
trigger**. A value with a default starts filled in, and a value without one is
required. The trigger editor then opens with the template's source, filters,
prompt, and project. Review the trigger and save it. Changing a template later
doesn't change triggers made from it.
