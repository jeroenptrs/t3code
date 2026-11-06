# Software factories

A factory turns T3 Code from a place where people run agents into a system that
runs agents on its own: work arrives through a trigger, a Foreman routes it
through roles, gates hold it for a human where that matters, and the results
feed back into the factory's own skills. This page records the design decisions
and the milestone order. It is fork-only work on top of upstream T3 Code.

The model follows Warp Factories, where a factory is a versioned folder of
agents, skills, automations, runners, and scorers, and every work item goes to a
Foreman agent first. See [factory as
code](https://www.warp.dev/blog/software-factory-as-code) and the [Warp factory
reference](https://docs.warp.dev/factories/factory-as-code/). The mapping below
keeps that shape and binds it to what T3 Code already has.

## Decisions

- **A factory is a definition plus runtime state.** The definition is files in
  a repo under `.t3/factories/<name>/`, so it is reviewable by merge request and
  a self-improvement run can change it by merge request. Runtime state (work
  items, runs, scores, proposals) lives in the T3 database under fork
  migrations. The UI reads both, and edits write files.
- **A role is a binding, not a program.** A role binds instructions, skills, a
  model and provider instance, a runtime mode, an isolation choice, and a tool
  allowlist. Roles are library objects shared across factories. The first set is
  foreman, implement, and review. Triage joins with native triggers, and
  analysis joins once implement and review are stable.
- **The Foreman is a prompt, not a pipeline.** Code owns ingress, the work item
  ledger, and gates. The Foreman decides routing, composes each child's task,
  holds the revision loop between implementer and reviewer, and talks to the
  human at gates. It does not write code.
- **The Foreman is not Home.** Upstream's Home agent is a per-user assistant
  that acts as the user across machines. A Foreman is per factory, server-owned,
  runs under the factory's scope, and gets a fresh session per work item. We take
  Home's thread-management toolkit and its wake-on-completion reports, and leave
  its opt-in setting, user attribution, and "do what the user can do" scope.
- **A work item is its own entity.** It spans several threads across stages and
  carries a source reference, a stage, and gate state. Threads stay what they
  are.
- **Stages start as skills.** Implement and review behaviour, including "checks
  must pass before handing back", ships first as instructions. A rule that fails
  twice in real use becomes a server-enforced gate.
- **Factories compose from library parts.** Projects (one or several, so a
  workspace project can span backend and frontend repos), trigger templates,
  roles, and skills are referenced by name. The factory itself is the wiring plus
  the Foreman's instructions.
- **Role prompts live on disk, with a baked-in default and the app as editor.**
  Three layers, lowest precedence first. The server ships one built-in
  instruction block per role, so a factory with no role files works. A role
  file at `.t3/factories/<name>/roles/<role>.md` carries the bindings in
  frontmatter and replaces the built-in body with its own. The Factories view
  edits those files and validates the bindings against the provider catalog.
  The database never stores a prompt. At launch the server appends the role body
  to the thread's instructions, the way Jira breakdown threads get theirs, binds
  the named skills into the provider's skill directory for that worktree, and
  the Foreman's task for the work item is the user message.
- **Access.** Operators view factories and their runs. Administrators manage
  them. The guard is a scope pair in `CLIENT_GUARDED_RPC_SCOPES`, so management
  can open to operators later without a redesign.
- **Factories get their own tab.** A Factories tab sits beside the current home
  view. Threads a factory owns and the scheduled tasks it owns leave the home
  view and appear there. Each tab shows an attention count for gates, failed
  runs, and questions.

## Trigger seam

A trigger is a source, filters, and a target. In M4 the persisted trigger is
the scheduled task: its schedule is the source and holds the filters, and its
project and thread binding is the target. The `Trigger` contract in
`packages/contracts/src/trigger.ts` is the library view of that, derived by
`scheduledTaskTrigger`. Its `target` is a union with one member, `thread`. A
factory target joins that union as the second member, so triggers start
factory work items without a second trigger model.

## Experimental dependencies

Anything built on upstream work that is not yet in upstream `main` is
experimental: it may change until it breaks for us, and we adapt rather than
block on it.

- Each pulled upstream PR is pinned by head SHA in a fork ledger with a one-line
  note of what we built on it. When upstream merges a different version, the
  ledger says what to re-apply.
- A factory service never imports from pulled upstream code directly. One
  adapter module per experimental dependency is the only place that knows its
  shape, so a breaking upstream change touches one file.
- When upstream merges, the fork feature graduates: drop the pinned PR, rebase
  the adapter onto the merged version, and re-apply what the feature needs.

Current experimental dependencies, all open upstream as of 2026-11-05:

| Upstream PR                                                                                | What we build on it                        |
| ------------------------------------------------------------------------------------------ | ------------------------------------------ |
| [#30323](https://github.com/pingdotgg/t3code/pull/30323) fresh provider session on send    | Foreman gets a fresh session per work item |
| [#30326](https://github.com/pingdotgg/t3code/pull/30326) scheduled tasks run in one thread | The Foreman's long-lived thread            |
| [#15975](https://github.com/pingdotgg/t3code/pull/15975) Home agent                        | Thread-management toolkit and wake reports |
| [#31129](https://github.com/pingdotgg/t3code/pull/31129) delivery modes on bound tasks     | Steer or restart on trigger delivery (M4)  |
| [#26254](https://github.com/pingdotgg/t3code/pull/26254) multi-repo projects               | Factories spanning several repos           |
| [#15350](https://github.com/pingdotgg/t3code/pull/15350) Docker sandboxes                  | Per-role runners (later)                   |
| [#21877](https://github.com/pingdotgg/t3code/pull/21877) follow-ups wait for nested work   | Foreman's revision loop sees final results |

The pinned head SHAs and the commits that carry them are in the
[software factories ledger](software-factories-ledger.md).

Delegation bugs we depend on being fixed: `parent_not_active` after a handoff
or settled parent ([#23006](https://github.com/pingdotgg/t3code/issues/23006),
[#16565](https://github.com/pingdotgg/t3code/issues/16565)) and a child reported
finished while still running
([#16603](https://github.com/pingdotgg/t3code/issues/16603)).

## What exists today

| Block              | Present                                                                                                          | Gap                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Ingress            | Scheduled tasks (interval, fixed time, once, webhook with HMAC, dedupe, filters), Slack app, Jira and PR watches | No native Jira or GitLab event sources, one trigger runs one prompt into one thread |
| Orchestration      | `delegate_task` with roles, worktree isolation, cross-environment targets                                        | No stored roles, no work item ledger, no join over children                         |
| Harness and access | Runtime modes, managed policy, scopes, Entra roles, provider instances, `request_secret`                         | Nothing binds them per role                                                         |
| Tools and skills   | Per-provider skill discovery, `$skill` mentions, per-thread instruction injection for Jira breakdown             | No create, edit, or per-role injection                                              |
| Verification       | Checkpoints, PR watch on checks, review guides, diff walkthroughs, browser and device preview, `evals/`          | No gate concept                                                                     |
| Self-improvement   | Insights, run metrics, PostHog counts                                                                            | No per-run record, scorers, or memory                                               |

## Milestones

Each milestone ships on its own.

### M0. Upstream footing (experimental)

- Pull #30323, #30326, and #15975 behind adapter modules, pinned in the ledger.
- Fix the delegation bugs listed above where they affect us.
- Set up the ledger and the adapter rule so later milestones have somewhere to
  put their dependencies.

### M1. Factory definition and the Factories tab

- Factory record: name, projects, roles, triggers, Foreman instructions. Files
  under `.t3/factories/`, runtime state in fork migrations.
- Three fixed roles: foreman, implement, review, each binding instructions,
  skills, model, runtime mode, isolation, and a tool allowlist.
- Factories tab beside home, with factory-owned threads and scheduled tasks
  moved there and an attention count on each tab.
- Operator view, administrator manage.
- Convert one existing scheduled task plus webhook into a factory to prove the
  shape.

### M2. Foreman thread and work item ledger

- One Foreman thread per factory, fresh session per work item, out of the
  sidebar.
- Work item entity with source reference, stage, owning threads, and gate state.
  The Foreman advances it through MCP tools, and the server records the
  transition.
- Runs list per factory, filterable by stage, role, and outcome.

### M3. Stage skills

- Implement and review as skills, with the review checklist and the "checks must
  pass before handing back" rule as instructions.
- Run real work through it and record where instructions alone fail. Whatever
  fails twice becomes a server gate.
- Role instruction bodies and stage skills are reviewed by a maintainer before a
  milestone that writes them is called done.

### M4. Native triggers and triage

- Trigger sources: schedule, webhook, Slack, Jira, GitLab, manual. Jira and
  GitLab start from the polling T3 already runs.
- Filters authored in the UI and evaluated by T3, so the Jira Automation rule
  moves inside T3.
- Trigger templates per source that factories fill in with values.
- Triage as a filter plus a routing instruction.
- Delivery mode per trigger (queue, steer, restart) once #31129 lands. It is
  still open as of 2026-11-05, so M4 ships without it.

### M5. Skills management

- List, create, and edit skills from T3, stored per project or in T3 home, and
  synced into each provider's skill directory.
- Per-role skill injection at thread launch, generalised from the Jira breakdown
  injection.

### M6. Analysis role and the spec artifact

- Analysis role that reads the work item, the Jira issue, and the relevant repos
  and writes a spec: scope, approach, affected repos, acceptance criteria, work
  packages. Runs in plan mode.
- Spec artifact stored on the work item, handed to implement, checked by review.
- Human gate on the spec, using the Jira proposal card pattern. Approvals work
  from mobile.

### M7. Canvas

- Read-only node graph per factory: triggers, Foreman, roles, gates, outputs,
  with edges showing who may spawn whom.

### M8. Scoring and self-improvement

- Run record with outcome, stage, duration, model, and cost, with retention from
  day one.
- Scorer role grading a sample of transcripts against a rubric in the
  definition.
- Scheduled self-improvement run that proposes skill and definition edits as a
  merge request.

### M9. Live canvas

- Nodes light up with active runs and edges show which work item is moving
  between them, built on the existing projection stream with no polling.

## Trial notes

Two real work items ran through a factory on the dev server on 2026-11-06,
after M3: a one-line bug fix with a test, and a docs change, in a throwaway
project with its own `npm run check`. Every role ran Claude Haiku. Both items
went new, implement, review, done without a gate, in about a minute each. The
Foreman wrote stand-alone tasks that named the branch, the base, the files,
and the done criteria. Both implementers committed with the checks passing.
Both reviewers ran the checks themselves and approved; one added a
non-blocking suggestion. Where instructions alone failed, or could not be
checked:

- **Isolation is the Foreman's choice, not the role's.** The implement role
  binds `isolation: worktree`, but the server does not apply role bindings to
  the children a Foreman delegates; `delegate_task` runs with whatever the
  Foreman passes. The first item's children worked in the project checkout
  and left it on the feature branch. The second item's children got worktrees.
  Once more and this becomes a server rule: a delegation from a Foreman takes
  the child role's binding (isolation, model, modes) over the call's arguments.
- **A missing precondition got improvised.** The project had no git identity.
  The implement skill says to stop and report what is missing, but the
  implementer set an author from the session's user and committed anyway. A
  precondition the factory can check (git identity, a clean checkout) belongs
  in code before the first child starts.
- **Whether a child read its skill is not recorded.** The skills were on disk
  in the child's directory, and the children behaved as the skills say, but
  the Foreman's task already carried most of the same instructions. The work
  log, not the ledger, would show a skill invocation. Nothing to fix yet; keep
  the question for the next trial with a thinner task.
- **A Foreman on a small model asks for confirmation.** In the M2 proof, with
  no stage skills yet, the Haiku Foreman held a trivial item at a gate to ask
  whether it could mark it done. With the stage skills in place it routed both
  items without asking.
