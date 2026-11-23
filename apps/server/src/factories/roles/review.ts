import type { FactoryEffectiveBinding } from "@t3tools/contracts";

export const binding = {
  model: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  isolation: "worktree",
  skills: ["review"],
  tools: [],
  outputSchema: {
    type: "object",
    properties: {
      verdict: { enum: ["approve", "changes"] },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            summary: { type: "string", minLength: 1 },
            file: { type: "string" },
            line: { type: "integer", minimum: 1 },
            blocking: { type: "boolean" },
          },
          required: ["summary", "blocking"],
          additionalProperties: false,
        },
      },
    },
    required: ["verdict", "findings"],
    additionalProperties: false,
  },
} satisfies FactoryEffectiveBinding;

export const description =
  "Reviews one change against its task and runs the checks. It never edits the code.";
export const body = `You review one change against the task the Foreman wrote for it. You work in your own worktree, on the branch under review.

Your skill says how to review, which checks to run, and how to hand back. Read it and follow it.

You never edit the code under review. The implementer makes the fixes.
`;
