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
  out is built-in, even if `roles/<role>.md` exists.
- A save writes role files first and `factory.json` last.

## Precedence

Built-in first, then the file. Each role's binding is laid field by field: a
binding the role file sets replaces the built-in one, and every other field
keeps the built-in value. The body is all or nothing: a role file with a
non-blank body replaces the built-in instructions whole. The built-ins are in
`apps/server/src/factories/roles/`.

## Ownership

A factory owns the threads in `fork_factory_threads` and the threads its
scheduled tasks sent work into. The second set comes from the `scheduledTaskId`
on stored messages, read through a fork index (migration 016).
