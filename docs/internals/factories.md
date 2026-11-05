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
```

- The directory names the factory. A `name` in `factory.json` that differs is
  an issue, and the directory's name wins.
- The id is `factory:<projectId>:<name>`, so renaming the directory makes a
  different factory, and its `fork_factory_threads` rows stay with the old id.
- `factory.json` lists the file for each role that has one. A role it leaves
  out uses `roles/<role>.md` when that file exists, else the built-in default.
- A save writes role files first and `factory.json` last.

## Precedence

Built-in first, then the file. Each role's binding is laid field by field: a
binding the role file sets replaces the built-in one, and every other field
keeps the built-in value. The body is all or nothing: a role file with a
non-blank body replaces the built-in instructions whole. The built-ins are in
`apps/server/src/factories/roles/`.

## Ownership

A factory owns the threads in `fork_factory_threads`, the threads its work items
name, and the threads its scheduled tasks sent work into. The last set comes
from the `scheduledTaskId` on stored messages, read through a fork index
(migration 016).

## Work items and the Foreman

Each request the Foreman routes is a row in `fork_factory_work_items`, with its
threads and transitions beside it (migration 017). `canTransitionWorkItem` in
contracts is the only stage table. Each stage change writes one transition row
with its actor, and only a person's gate answer moves an item out of `waiting`.

- The Foreman is one thread per factory with a `factory-foreman:` id. Its
  `fork_factory_threads` row lands before the launch, so its first provider
  session gets the role. An archived or deleted one is replaced next time.
- Each item is a `freshContext` queue send, and that send's run is the item's
  `foreman_run_id`. A `delegate_task` child joins the item whose fresh run last
  preceded its parent's run.
- A queued item starts once the Foreman's run ends, which it does while children
  work. So an earlier item's child wakes can land in a later item's session.
- `FactoryThreads` reads the role body on every session prepare, outside the MCP
  credential, so an edited role file applies from the next session.
