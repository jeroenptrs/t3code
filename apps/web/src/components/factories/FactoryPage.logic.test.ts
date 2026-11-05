import {
  FactoryId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type Factory,
  type FactoryRole,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildFactorySaveInput, factoryDraft, factoryDraftChanged } from "./FactoryPage.logic";

const projectId = ProjectId.make("project-api");
const taskId = ScheduledTaskId.make("task-nightly");
const model = { instanceId: ProviderInstanceId.make("claude"), model: "claude-haiku-5-5" };

const builtinRole = (role: FactoryRole["role"]): FactoryRole => ({
  role,
  path: null,
  source: "builtin",
  fileBinding: {},
  binding: {
    model: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    isolation: "worktree",
    skills: [],
    tools: [],
  },
  body: `Built-in ${role} instructions.`,
  bodySource: "builtin",
});

const factory: Factory = {
  id: FactoryId.make("factory:project-api:nightly-triage"),
  projectId,
  name: "nightly-triage",
  definition: {
    name: "nightly-triage",
    projects: ["web"],
    triggers: [{ kind: "scheduled_task", scheduledTaskId: taskId }],
    roles: { review: "roles/review.md" },
  },
  projects: [{ name: "web", projectId: ProjectId.make("project-web") }],
  roles: [
    builtinRole("foreman"),
    builtinRole("implement"),
    {
      role: "review",
      path: "roles/review.md",
      source: "file",
      fileBinding: { model, skills: ["review-checklist"] },
      binding: { ...builtinRole("review").binding, model, skills: ["review-checklist"] },
      body: "Review against the task.",
      bodySource: "file",
    },
  ],
  issues: [],
  scheduledTaskIds: [taskId],
  threads: [],
  attention: { gatesWaiting: 0, failedRuns: 0, questions: 0, total: 0 },
};

describe("buildFactorySaveInput", () => {
  it("sends the definition unchanged and no role files when nothing was edited", () => {
    const draft = factoryDraft(factory);
    expect(factoryDraftChanged(factory, draft)).toBe(false);
    expect(buildFactorySaveInput(factory, draft)).toEqual({
      projectId,
      definition: factory.definition,
    });
  });

  it("writes only the edited roles, keeping a built-in body built-in", () => {
    const draft = factoryDraft(factory);
    const edited = {
      ...draft,
      projects: ["web", "docs"],
      triggers: [],
      roles: {
        ...draft.roles,
        foreman: { ...draft.roles.foreman, binding: { runtimeMode: "approval-required" as const } },
        implement: { ...draft.roles.implement, tools: " Bash, Edit ,, Bash", skills: "  " },
        review: { ...draft.roles.review, useBuiltin: true },
      },
    };
    expect(factoryDraftChanged(factory, edited)).toBe(true);
    expect(buildFactorySaveInput(factory, edited)).toEqual({
      projectId,
      definition: { ...factory.definition, projects: ["web", "docs"], triggers: [] },
      roles: [
        { role: "foreman", file: { binding: { runtimeMode: "approval-required" }, body: null } },
        { role: "implement", file: { binding: { tools: ["Bash", "Edit"] }, body: null } },
        { role: "review", file: null },
      ],
    });
  });

  it("writes an edited body and keeps the role file's own bindings", () => {
    const draft = factoryDraft(factory);
    const edited = {
      ...draft,
      roles: {
        ...draft.roles,
        foreman: { ...draft.roles.foreman, body: "Route every item to review first." },
        review: { ...draft.roles.review, body: "   " },
      },
    };
    expect(buildFactorySaveInput(factory, edited).roles).toEqual([
      { role: "foreman", file: { binding: {}, body: "Route every item to review first." } },
      { role: "review", file: { binding: { model, skills: ["review-checklist"] }, body: null } },
    ]);
  });

  it("sends no change for a built-in role reset to built-in", () => {
    const draft = factoryDraft(factory);
    const edited = {
      ...draft,
      roles: { ...draft.roles, implement: { ...draft.roles.implement, useBuiltin: true } },
    };
    expect(buildFactorySaveInput(factory, edited).roles).toBeUndefined();
  });
});
