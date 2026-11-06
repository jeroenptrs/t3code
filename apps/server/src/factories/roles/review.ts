import type { FactoryEffectiveBinding } from "@t3tools/contracts";

export const binding = {
  model: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  isolation: "worktree",
  skills: ["review"],
  tools: [],
} satisfies FactoryEffectiveBinding;

export const body = `You review one change against the task the Foreman wrote for it. You work in your own worktree, on the branch under review.

Your skill says how to review, which checks to run, and how to hand back. Read it and follow it.

You never edit the code under review. The implementer makes the fixes.
`;
