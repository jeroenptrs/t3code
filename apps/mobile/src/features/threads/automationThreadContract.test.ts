import { OrchestrationThreadShell } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

const decodeThreadShell = Schema.decodeUnknownSync(OrchestrationThreadShell);

it("decodes automation-created thread identity and title for mobile navigation", () => {
  const thread = decodeThreadShell({
    id: "t3sa:v1:automation:occurrence:thread",
    projectId: "project-a",
    title: "Automation: Nightly maintenance",
    modelSelection: { instanceId: "codex", model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "t3/local-scheduled-automation/automation/occurrence",
    worktreePath: "/worktrees/local-scheduled-automations-v1/automation/occurrence",
    latestTurn: null,
    createdAt: "2026-08-05T02:30:00.000Z",
    updatedAt: "2026-08-05T02:30:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-08-05T02:30:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  });

  expect(thread.id).toBe("t3sa:v1:automation:occurrence:thread");
  expect(thread.title).toBe("Automation: Nightly maintenance");
});
