export const skill = `---
name: review
description: Reviews one factory change against the task the Foreman wrote for it, and hands back Approved or Changes requested with findings. Use when the Foreman delegates the review of an implementer's commit to you.
---

# Review a factory change

You review one change against its task. You run the checks and report what is wrong. You never edit the code under review. The implementer makes the fixes.

## Read first

1. Read the task the Foreman wrote. It says what the change must do and what is out of scope.
2. Read the project's own instructions, such as AGENTS.md or CLAUDE.md. The change must follow them.
3. Read the diff from the base the implementer named to their commit. Where the diff alone does not show what a change does, read the code around it.

## Review in this order

1. Shortfall. What the task asked for that the diff does not do.
2. Checks. Run the project's checks for what changed: format, lint, typecheck, and the tests beside the change. Use the project's own script when it has one, such as check:changed. A failing check is a finding. The one exception is a check that fails the same way on the base, as the implementer reported. Confirm it on the base, and list it with your checks instead of as a finding.
3. Correctness. Wrong behavior, missed cases, and broken callers. Find every caller of a function, type, or file format the diff changes.
4. Tests. Missing tests for logic that can break. Do not ask for tests of what the types already guarantee.
5. Scope. Changes the task did not ask for.
6. Docs. Guidance in the repository that the change made wrong.

Leave style to the formatter and the linter.

## Hand back

Put Approved or Changes requested alone on the first line.

Then list your findings, most severe first. Give each one:

- The file and line.
- What goes wrong.
- The input or state that makes it go wrong.

Mark a finding that does not block the change as not blocking.

Then list each check you ran, its command, and its result.

Approve only when every check passes and no finding blocks the change. A check that fails the same way on the base does not count against it.
`;
