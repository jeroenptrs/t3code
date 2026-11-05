export const skill = `---
name: implement
description: Takes one implementation task from a factory's Foreman to a commit whose checks pass. Use when the Foreman delegates an implementation task to you, or sends back the findings of a review.
---

# Implement a factory task

You implement one task the Foreman wrote. Another agent reviews your commit next, so hand back a commit whose checks pass.

## Read first

1. Read the task in full: the goal, the branch, the files to read, what is out of scope, and how you know you are done.
2. Read the project's own instructions, such as AGENTS.md, CLAUDE.md, or CONTRIBUTING.md. Where they ask for more than this skill, follow them.
3. Read the files the task points to before you change anything.
4. If the task leaves out something you need, stop and say so in your hand-back. Do not guess.

## Make the change

- Work in this worktree, on the branch the task names. If the branch does not exist, create it from the base the task names.
- Make the change the task asks for, and only that change. Leave unrelated code alone, even where it looks wrong.
- Add tests for logic that can break, beside the code you changed.
- When the Foreman sends back review findings, fix each one, or say in your hand-back why it does not apply.

## Run the checks

Run the project's checks for what you changed: format, lint, typecheck, and the tests beside your change. Use the project's own script for this when it has one, such as check:changed. Do not run the whole suite unless the project says to.

When a check fails, fix the cause and run the check again. Repeat until it passes.

Every check must pass before you hand back. The one exception is a check that fails for a reason outside your change. Run it on the base to confirm it fails there too, then leave it and put its output in your hand-back.

## Commit

Commit your work on the branch, with a message in the project's style. Push, open a pull request, or merge only when the task says to.

## Hand back

Reply with:

- One or two sentences on what you changed.
- The commit SHA and the base commit it builds on.
- Each check you ran, its command, and its result.
- For a check that fails outside your change, its output and how you confirmed it fails on the base.
- What the task asked for that you left out, and why.
`;
