# Factories

A factory gives a project its own foreman, implement, and review roles. Its definition is files in
the project, under `.t3/factories/<name>/`, so you review a change to a factory like any other
change to the repository.

Operators and administrators see factories. Only administrators create and edit them.

## Find your factories

When a connected environment has a factory, or you are an administrator there, the sidebar shows
two tabs above the thread list: **Home** and **Factories**. Threads a factory owns, and the
threads its scheduled tasks start, move from **Home** to **Factories**. The sidebar remembers the
tab you last chose in this browser.

Each tab shows how many of its threads need you: a thread whose latest run failed counts once,
and a thread waiting on your answer counts once. **Factories** also counts each work item a gate
holds for you, and each work item that failed without a person failing it.

In **Factories**, the chevron beside a factory shows the threads and scheduled tasks it owns. A
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

## Edit a factory

The factory page lists any problems in its files, then the definition and the three roles.

- **Projects** are the other projects the factory may work in, by name. Its own project is always
  included.
- **Triggers** are the project's scheduled tasks, webhooks included, that send it work. Click one
  to open it in **Settings > Scheduled tasks**.
- Each role shows its model, runtime mode, interaction mode, where it works, its skills, its tool
  allowlist, and its instructions. **Built-in** means the role has no file yet.

Edit any of these and click **Save**. A role you change gets its own file at
`roles/<role>.md`, holding only the settings you set. **Use built-in instructions** deletes the
role's file when you save, so the role goes back to the built-in settings and instructions. A
blank **Instructions** box also keeps the built-in instructions.

If the server refuses a save, such as for a model the provider does not offer, the reason appears
beside the field and nothing is written.

## Send work to a factory

Each request you send a factory is a work item. The factory's Foreman gets it as a new message in
a fresh session, routes it to implement and review, and moves it through the stages **New**,
**Implement**, and **Review** to **Done**, **Failed**, or **Dropped**. The Foreman is one thread
per factory, named `Foreman: <factory>`, and starts the first time the factory gets work. The
factory page header links to it as **Foreman thread**, and in the **Factories** tab it shows first
under its factory.

### Follow the work

The factory page lists its work items under **Work items**, newest first, with the threads that
worked on each one. Filter the list by stage, by the role of a thread that worked on the item, or
by outcome. **Active** is every item that has not ended. The filters stay in the page's address,
so a reload or a shared link keeps them.

Click an item's title to see its request, the question a gate holds it on, and each stage change
with who made it. The list does not update live. To read it again, click the refresh button
beside **Work items**.

To create a work item, open the factory's page, enter a title and the request, and send it. Only
administrators can create work items. An agent can also send one for you when you ask it to.

### Answer a gate

When the Foreman needs a decision, it holds the work item at **waiting** with a question, and the
factory's attention count goes up. Open the work item, read the question, and approve or reject
it, with a note if you want. Approving sends the item back to the stage the Foreman asked for.
Rejecting drops it. The Foreman reads your answer and note in the item's session.
