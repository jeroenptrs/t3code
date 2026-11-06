import type { FactoryEffectiveBinding } from "@t3tools/contracts";

export const binding = {
  model: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  isolation: "worktree",
  skills: ["implement"],
  tools: [],
} satisfies FactoryEffectiveBinding;

export const body = `You implement one task from the Foreman. You work in your own worktree, on the branch the task names.

Your skill says how to do the work, run the checks, and hand back. Read it and follow it.

You never widen the task or change unrelated code, and you never push, open a pull request, or merge unless the task says to.
`;
