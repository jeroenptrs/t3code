# Factories

A factory runs a project's work through agents. Each request is a work item, and a Foreman agent
routes it to the factory's roles, such as implement and review. Its definition is files in the
project, under `.t3/factories/<name>/`, so you review a change to a factory like any other
change to the repository.

Operators and administrators see factories. Only administrators create and edit them.

## Find your factories

When a connected environment has a factory, or you are an administrator there, the sidebar shows
two tabs above the thread list: **Home** and **Factories**. Threads a factory owns, and the
threads its triggers start, move from **Home** to **Factories**. The sidebar remembers the
tab you last chose in this browser.

In **Factories**, the chevron beside a factory shows its runs and its triggers. A run is the thread
that handles one work item. Runs sit in the same sections as threads in **Home**, so a run you
settle or snooze moves out of the way. As in **Home**, **Settled** lists the newest runs first and
**Show more** reveals older ones. The agents a run starts for its roles show inside the run's
thread, not as rows of their own. A run opens and acts like any other thread. Click the factory's
name to open its page.

Each tab shows how many of its threads need you. A thread whose latest run failed counts once, and
a thread waiting on your answer counts once. **Factories** also counts each work item a gate holds
for you, and each failed work item. A failed item stops counting when a person failed it, when you
dismiss the failure, or when you settle, archive, or delete its run.

From the command palette, **Open Factories** switches the sidebar to the tab, and **Go to
factory…** opens a factory by name.

## Create a factory

1. In the **Factories** tab, click **New factory**.
2. Pick the environment and the project the factory belongs to.
3. Enter a name of lowercase letters, digits, and hyphens, such as `nightly-triage`. The name is
   the folder under `.t3/factories/`.
4. Click **Create factory**. The factory page opens.

A new factory has the Foreman and the implement and review roles, with their built-in instructions
until you change them.

## The factory page

A factory's page opens on **Overview**: a canvas of how work moves from its triggers through the
Foreman to its roles, and **Needs you**, the gates to answer and failed items to look at. Click a
trigger on the canvas to see the factory's triggers, or a role to open it. Each row under
**Needs you** opens the item's run thread.

The other tabs are **Work items**, **Roles**, **Skills**, **Triggers**, and **Settings**. Each
saves its own changes. A tab with a problem in the factory's files shows how many beside its name.
The tab is part of the page's address, so a reload or a shared link keeps it.

## Edit a factory

- **Roles** lists the Foreman and the factory's other roles. Click a role to edit its
  description, its instructions, the skills it binds, and its model, runtime mode, interaction
  mode, and where it works, then click **Save changes**. The description is one line on what the
  role is for. The Foreman reads it to decide which role gets which work, so give a role you add,
  such as `checks`, a description that says when to use it. A role you change gets its own file at `roles/<role>.md`.
- **Remove role**, at the bottom of a role's page, takes the role out of the factory and deletes
  its file. The Foreman cannot be removed.
- **Triggers** lists the triggers that send the factory work, with their source, filters, and what
  a polled trigger acts on first. Click a trigger to edit it.
- **Settings** holds the other projects the factory may work in, the Foreman's model and where it
  works, and **Delete factory**.

If the server refuses a save, such as for a model the provider does not offer or a skill that does
not exist, the reason appears beside the field and nothing is written.

### Add a role

1. On the **Roles** tab, click **Add role**.
2. Enter a name of lowercase letters, digits, and hyphens, such as `triage`.
3. Under **Start from**, pick a preset or **From scratch**.
4. Click **Add role**, then open the role to write its instructions and set its model.

T3 Code ships implement, review, and analysis as presets. Analysis plans the work and writes up the
scope, approach, and acceptance criteria without changing code. A role you add under a preset's own
name follows that preset until you change it. A role under any other name starts as a copy of the
preset, or with no instructions when you start from scratch.

### Turn a role off

The switch beside a role on the **Roles** tab turns it on or off and saves at once. The Foreman
routes work only to roles that are on, so turn a role off to stop using it without losing its
instructions. The Foreman is always on.

### Attach a trigger

To have a trigger send this factory work, click **Add trigger** on the **Triggers** tab. The trigger
form opens with the factory as its target. To reuse a trigger the project already has, click the
arrow beside **Add trigger** and pick it.

To stop a trigger sending work here, click its detach button. The trigger stays in **Settings >
Triggers**, so you can attach it again later.

### Run the Foreman in a worktree

By default the Foreman works in the project's checkout. To give each run a worktree of its own, open
**Settings** on the factory page, set **Works in** under **Foreman** to **Own worktree**, and save.
A run then starts once its worktree is ready.

## Give a role skills

A skill is a folder of instructions an agent loads when its task calls for them. The implement and
review roles start with the built-in `implement` and `review` skills, which hold the checks that
must pass before a change goes to review and the review checklist.

To add your own skill, click **New skill** on the factory's **Skills** tab, or create
`.t3/factories/<name>/skills/<skill>/SKILL.md` in the project with `name` and `description`
frontmatter. Then add it on a role's page under **Skills** with **Add skill**. A role uses a skill as written. Edit
the skill itself on the **Skills** tab, which also shows which roles bind each skill. A skill with the name of a built-in skill replaces that
skill.

When a role's agent starts, T3 Code copies its skills into the folder the agent works in, under
`.agents/skills`, `.claude/skills`, and `.codex/skills`, where each provider looks, and hides them
from git there. A skill you take off a role stays in a worktree that already has it until the
worktree is removed.

## Send work to a factory

Each request you send a factory is a work item. Each item starts its own run, a Foreman thread
titled after the item, as soon as you create it. Runs do not wait for each other. An item is
**New** until the Foreman starts its first agent, then **Working** until it ends as **Done**,
**Failed**, or **Dropped**. While it works, the Foreman can run several agents on it at once: two
implementers on separate parts, or review and checks side by side. Each agent runs as one role,
with that role's model, skills, and checkout.

To create a work item:

1. In the sidebar's **Factories** tab, click **+** beside the factory. On the factory's **Work
   items** tab, **New work item** does the same, and so does **New work item…** in the command
   palette on the factory page.
2. Enter a title and the request.
3. Click **Create work item**.

A trigger attached to the factory creates work items the same way. Only administrators can create
work items. An agent can also send one for you when you ask it to.

If the Foreman's model names a provider that is not set up or is turned off, or a model the provider
does not offer, the item fails at once with that reason and no run starts. Fix the model under
**Foreman** on the **Settings** tab. A role with the same problem gets no agents until you fix it.

### Follow the work

To watch a run, open it in the sidebar under its factory. The run thread shows what the Foreman
decides and the agents it starts for each role. On the Overview canvas, each role lights while an
agent runs as it, with a count when more than one does.

The **Work items** tab lists the factory's items, newest first. Filter them by stage or by outcome.
**Active** is every item that has not ended. The list does not update live. The refresh button
beside **New work item** reads it again.

Beside a working item's stage, the list names the roles it has agents running as. Click an item to
see its request and its stage history with who made each change. The history notes the role each
agent was started as. **Open run
thread** opens its run. From there you can also:

- **Drop item** ends an item that has not ended. Its run is told to stop.
- **Dismiss failure** stops a failed item from asking for your attention. The item stays in the
  list and reads as dismissed. **Restore failure** makes it ask again.

### Answer a gate

When the Foreman needs a decision, it holds the work item at **Waiting** with a question, and the
item shows under **Needs you** on the Overview. Open the item on the **Work items** tab, read the
question, then click **Approve** or **Reject**. A rejection needs a note that says why. An approval
takes an optional note. Approving sends the item back to work, or marks it done when that is what
the Foreman asked.
Rejecting drops it. The Foreman reads your answer and note in the item's thread.

Only administrators can answer a gate, drop an item, or dismiss a failure. Operators see the
question.
