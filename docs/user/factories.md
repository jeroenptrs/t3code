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
and a thread waiting on your answer counts once.

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
