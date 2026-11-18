# Factories

A factory gives a project its own foreman, implement, and review roles. Its definition is files in
the project, under `.t3/factories/<name>/`, so you review a change to a factory like any other
change to the repository.

Operators and administrators see factories. Only administrators create and edit them.

## Find your factories

When a connected environment has a factory, or you are an administrator there, the sidebar shows
two tabs above the thread list: **Home** and **Factories**. Threads a factory owns, and the
threads its triggers start, move from **Home** to **Factories**. The sidebar remembers the
tab you last chose in this browser.

Each tab shows how many of its threads need you: a thread whose latest run failed counts once,
and a thread waiting on your answer counts once. **Factories** also counts each work item a gate
holds for you, and each work item that failed without a person failing it.

In **Factories**, the chevron beside a factory shows the threads and triggers it owns. A
thread there opens and acts like any other thread. Click the factory's name to open its page.

From the command palette, **Open Factories** switches the sidebar to the tab, and **Go to
factory…** opens a factory by name.

## Create a factory

1. In the **Factories** tab, click **New factory**.
2. Pick the environment and the project the factory belongs to.
3. Enter a name of lowercase letters, digits, and hyphens, such as `nightly-triage`. The name is
   the folder under `.t3/factories/`.
4. Click **Create factory**. The factory page opens.

A new factory uses the built-in foreman, implement, and review roles until you change them.

## The factory page

A factory's page opens on **Overview**: a canvas of how work moves from its triggers through the
Foreman to its roles, and **Needs you**, the gates to answer and failed items to look at. Click a
trigger on the canvas to see the factory's triggers, or a role to open it. Each row under
**Needs you** opens the item's run thread.

The other tabs are **Work items**, **Roles**, **Skills**, **Triggers**, and **Settings**. Each
saves its own changes. A tab with a problem in the factory's files shows how many beside its name.
The tab is part of the page's address, so a reload or a shared link keeps it.

## Edit a factory

- **Roles** lists the Foreman and the factory's other roles. The switch beside a role turns it on
  or off at once; the Foreman is always on. Click a role to edit its instructions, the skills it
  binds, and its model, runtime mode, interaction mode, and where it works, then click **Save
  changes**. A role you change gets its own file at `roles/<role>.md`.
- **Add role** starts a role from a preset or from scratch. A preset added under its own name has
  no file, so it follows the preset; under another name it starts as a copy of the preset.
  **Remove role**, at the bottom of a role's page, takes it out of the factory and deletes its
  file.
- **Triggers** lists the triggers that send the factory work, with their source, filters, and what
  a polled trigger acts on first. **Add trigger** opens the trigger form with the factory as its
  target; the arrow beside it attaches a trigger the project already has. Click a trigger to edit
  it. **Detach** stops it sending work here and leaves it in **Settings > Triggers**.
- **Settings** holds the other projects the factory may work in, the Foreman's model and where it
  works, and **Delete factory**.

If the server refuses a save, such as for a model the provider does not offer or a skill that does
not exist, the reason appears beside the field and nothing is written.

## Give a role skills

A skill is a folder of instructions an agent loads when its task calls for them. The implement and
review roles start with the built-in `implement` and `review` skills, which hold the checks that
must pass before a change goes to review and the review checklist.

To add your own skill, click **New skill** on the factory's **Skills** tab, or create
`.t3/factories/<name>/skills/<skill>/SKILL.md` in the project with `name` and `description`
frontmatter. Then add it on a role's page under **Skills**. A role uses a skill as written; edit
the skill itself on the **Skills** tab. A skill with the name of a built-in skill replaces that
skill.

When a role's agent starts, T3 Code copies its skills into the folder the agent works in, under
`.agents/skills`, `.claude/skills`, and `.codex/skills`, where each provider looks, and hides them
from git there. A skill you take off a role stays in a worktree that already has it until the
worktree is removed.

## Send work to a factory

Each request you send a factory is a work item. Each item runs in its own Foreman thread, which
routes it to the factory's roles and moves it through the stages **New**, a stage per role, and
then **Done**, **Failed**, or **Dropped**.

To create a work item:

1. On the factory's **Work items** tab, click **New work item**. On the factory page, **New work
   item…** in the command palette does the same.
2. Enter a title and the request.
3. Click **Create work item**.

Only administrators can create work items. An agent can also send one for you when you ask it to.

### Follow the work

The **Work items** tab lists the factory's items, newest first. Filter them by stage or by outcome.
**Active** is every item that has not ended. The list does not update live; the refresh button
beside **New work item** reads it again.

Click an item to see its request, its stage history with who made each change, and a link to its
run thread. From there you can also:

- **Drop item**: end an item that has not ended. Its Foreman thread is told to stop.
- **Dismiss failure**: stop a failed item from asking for your attention. The item stays in the
  list and reads as dismissed. **Restore failure** undoes it.

### Answer a gate

When the Foreman needs a decision, it holds the work item at **Waiting** with a question, and the
item shows under **Needs you** on the Overview. Open the item on the **Work items** tab, read the
question, then click **Approve** or **Reject**. A rejection needs a note that says why. An approval
takes an optional note. Approving sends the item back to the stage the Foreman asked for.
Rejecting drops it. The Foreman reads your answer and note in the item's thread.

Only administrators can answer a gate, drop an item, or dismiss a failure. Operators see the
question.
