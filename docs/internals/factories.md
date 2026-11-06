# Factories

A factory's definition is files in its owning project's checkout. The server
reads and writes them through `FactoryService`; the database holds only runtime
state and never a prompt. The design and milestones are in
[software factories](software-factories.md).

## File layout

```
<project root>/.t3/factories/<name>/
  factory.json        name, projects, triggers, roles
  roles/<role>.md     YAML frontmatter with bindings, then the instructions
  skills/<skill>/     SKILL.md and its supporting files, in the Agent Skills format
```

- The directory names the factory. A `name` in `factory.json` that differs is
  an issue, and the directory's name wins.
- The id is `factory:<projectId>:<name>`, so renaming the directory makes a
  different factory, and its `fork_factory_threads` rows stay with the old id.
- `factory.json` lists the file for each role that has one. A role it leaves
  out uses `roles/<role>.md` when that file exists, else the built-in default.
- A save writes skill and role files first and `factory.json` last.

## Precedence

Built-in first, then the file. Each role's binding is laid field by field: a
binding the role file sets replaces the built-in one, and every other field
keeps the built-in value. The body is all or nothing: a role file with a
non-blank body replaces the built-in instructions whole. The built-ins are in
`apps/server/src/factories/roles/`.

Skills resolve the same way, by name. A `skills/<name>/` with a `SKILL.md`
replaces the built-in skill of that name whole, and a name a role binds that is
neither is an `unknown_skill` issue. The built-in skills are in
`apps/server/src/factories/skills/`.

## Skills in the role's worktree

Claude reads `.claude/skills`, Codex and Antigravity `.agents/skills`, and fx
`.codex/skills`, so `FactorySkills.materialize` writes each skill
a thread's role binds to `<cwd>/.agents/skills/<name>/` and links
`.claude/skills/<name>` and `.codex/skills/<name>` to it. It runs when the
thread's provider session opens or the thread joins one, before the provider
reads its skills, so an edited skill applies from the thread's next session.

- It writes a file only when its content differs.
- It adds each path it owns to the checkout's exclude file, from
  `git rev-parse --git-path info/exclude`, which linked worktrees share. The
  agent's `git status` stays clean, and `.gitignore` is never touched.
- It never writes a tracked path. A skill whose path the checkout tracks is
  skipped, and so is a path that something other than a link already holds.
- Nothing removes a skill. One the role stops binding stays until the worktree
  goes.

## Ownership

A factory owns the threads in `fork_factory_threads`, the threads its work items
name, and the threads its scheduled tasks sent work into. The last set comes
from the `scheduledTaskId` on stored messages, read through a fork index
(migration 016).

## Work items and the Foreman

Each request the Foreman routes is a row in `fork_factory_work_items`, with its
threads and transitions beside it (migration 019). `canTransitionWorkItem` in
contracts is the only stage table. Each stage change writes one transition row
with its actor, and only a person's gate answer moves an item out of `waiting`.
A row whose two stages match changes nothing: it is a note the server keeps on
the item's log.

- The Foreman is one thread per factory with a `factory-foreman:` id. Its
  `fork_factory_threads` row lands before the launch, so its first provider
  session gets the role. An archived or deleted one is replaced next time.
- Each item is a `freshContext` queue send, and that send's run is the item's
  `foreman_run_id`. A `delegate_task` child joins the item whose fresh run last
  preceded its parent's run.
- A factory has one active item: sent, and not yet `done`, `failed`, or
  `dropped`. A `waiting` item stays active, because the gate answer continues
  its session. A new item created while one is active or queued starts at `queued`
  (fork migration 021 moved older waiting rows there), so no child wakes into
  a later item's session. The stage change that ends an item, and a creation
  that finds no active item, move the oldest queued one to `new` and send it,
  under the same per-factory lock. Only the
  server moves an item out of `queued`. An item the server cannot send fails,
  and the next one is tried.
  In M2 nothing sends a queued item when the server starts. The next item
  created or ended does.
- `FactoryThreads` reads the role body on every session prepare, outside the MCP
  credential, so an edited role file applies from the next session.
- A Foreman's `delegate_task` with the `implementation` or `review` role takes
  the matching role's effective binding: isolation, runtime mode, interaction
  mode, and the model when the binding names one. A call argument that differs
  loses, and the item's log notes what applied and what it replaced. Other
  threads' delegations, and a Foreman's other roles, keep their arguments.
- Before an item's first child, the same step runs `git var GIT_COMMITTER_IDENT`
  in the project checkout. When Git has no committer identity, the server holds
  the item at a gate that says what is unset, and the delegation fails, so no
  child guesses an identity. The person sets it and approves; the Foreman's next
  delegation checks again.
- A child the Foreman delegates has no row, since writing one would race its
  first session. `FactoryThreads` finds it by lineage and gives it the implement
  or review body its task's role names. The task record keeps that role only as
  the prompt prefix `taskPrompt` writes, which `taskRoleOfPrompt` reads back.
