import {
  FactoryId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type Factory,
  type FactoryRole,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addRoleSaveInput,
  removeRoleSaveInput,
  roleDraft,
  roleDraftChanged,
  roleFileChange,
  roleNameError,
  skillUsers,
} from "./FactoryRoles.logic";

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
    skills: role === "implement" ? ["implement"] : [],
    tools: [],
  },
  description: `Built-in ${role} description.`,
  enabled: true,
  body: `Built-in ${role} instructions.`,
  bodySource: "builtin",
  skills: [],
});

const review: FactoryRole = {
  role: "review",
  path: "roles/review.md",
  source: "file",
  fileBinding: {
    enabled: false,
    description: "Reviews against the task.",
    model,
    skills: ["review-checklist"],
    tools: ["Read"],
  },
  binding: {
    ...builtinRole("review").binding,
    model,
    skills: ["review-checklist"],
    tools: ["Read"],
  },
  description: "Reviews against the task.",
  enabled: false,
  body: "Review against the task.",
  bodySource: "file",
  skills: [{ name: "review-checklist", source: "factory", description: "", replaces: null }],
};

const factory: Factory = {
  id: FactoryId.make("factory:project-api:nightly-triage"),
  projectId,
  name: "nightly-triage",
  definition: {
    version: 2,
    name: "nightly-triage",
    projects: ["web"],
    roles: { review: "roles/review.md", implement: null },
  },
  projects: [{ name: "web", projectId: ProjectId.make("project-web") }],
  roles: [builtinRole("foreman"), review, builtinRole("implement")],
  rolePresets: [],
  skills: [],
  issues: [],
  scheduledTaskIds: [taskId],
  threads: [],
  attention: { gatesWaiting: 0, failedRuns: 0, questions: 0, total: 0 },
};

describe("roleFileChange", () => {
  it("writes an edited description, and leaves a blank one to the preset", () => {
    const implement = builtinRole("implement");
    expect(
      roleFileChange(implement, { ...roleDraft(implement), description: " Fixes one bug. " }).file
        ?.binding,
    ).toEqual({ description: "Fixes one bug." });
    expect(
      roleFileChange(review, { ...roleDraft(review), description: "  " }).file?.binding,
    ).not.toHaveProperty("description");
  });

  it("leaves skills and instructions the preset gave unwritten", () => {
    const implement = builtinRole("implement");
    const draft = {
      ...roleDraft(implement),
      binding: { runtimeMode: "approval-required" as const },
    };
    expect(roleDraftChanged(implement, draft)).toBe(true);
    expect(roleFileChange(implement, draft)).toEqual({
      role: "implement",
      file: { binding: { runtimeMode: "approval-required" }, body: null },
    });
  });

  it("writes the edited body and skills over the role file's own bindings", () => {
    const draft = { ...roleDraft(review), skills: [], body: "Check the tests first." };
    expect(roleFileChange(review, draft)).toEqual({
      role: "review",
      file: {
        binding: {
          enabled: false,
          tools: ["Read"],
          description: "Reviews against the task.",
          model,
          skills: [],
        },
        body: "Check the tests first.",
      },
    });
  });

  it("drops a binding the person reset, such as the model back to the project default", () => {
    const draft = { ...roleDraft(review), binding: {} };
    expect(roleFileChange(review, draft).file?.binding).toEqual({
      enabled: false,
      tools: ["Read"],
      description: "Reviews against the task.",
      skills: ["review-checklist"],
    });
  });

  it("sees no change in a draft read straight from the role", () => {
    expect(roleDraftChanged(review, roleDraft(review))).toBe(false);
  });
});

describe("roleNameError", () => {
  it.each([
    ["", "empty"],
    ["x".repeat(65), "too_long"],
    ["Triage", "pattern"],
    ["two--hyphens", "pattern"],
    ["foreman", "reserved"],
    ["waiting", "reserved"],
    ["queued", "reserved"],
    ["review", "taken"],
    [" triage ", null],
  ] as const)("%j is %s", (name, error) => {
    expect(roleNameError(name, factory)).toBe(error);
  });
});

describe("addRoleSaveInput", () => {
  const preset = {
    name: "review" as FactoryRole["role"],
    binding: { ...builtinRole("review").binding, skills: ["review"] },
    description: "Reviews one change.",
    body: "Preset review instructions.",
  };

  it("lists a preset under its own name with no file", () => {
    const withoutReview = { ...factory, definition: { ...factory.definition, roles: {} } };
    expect(addRoleSaveInput(withoutReview, preset.name, { kind: "preset", preset })).toEqual({
      projectId,
      definition: { ...factory.definition, roles: { review: null } },
    });
  });

  it("copies a preset's bindings and instructions into a new role's file", () => {
    expect(addRoleSaveInput(factory, "security", { kind: "preset", preset })).toEqual({
      projectId,
      definition: {
        ...factory.definition,
        roles: { review: "roles/review.md", implement: null, security: null },
      },
      roles: [
        {
          role: "security",
          file: {
            binding: {
              runtimeMode: "full-access",
              interactionMode: "default",
              isolation: "worktree",
              description: "Reviews one change.",
              skills: ["review"],
            },
            body: "Preset review instructions.",
          },
        },
      ],
    });
  });

  it("starts a role from scratch without a file", () => {
    expect(addRoleSaveInput(factory, "triage", { kind: "scratch" }).roles).toBeUndefined();
  });
});

describe("removeRoleSaveInput", () => {
  it("takes the role out of the definition and deletes its file", () => {
    expect(removeRoleSaveInput(factory, "review")).toEqual({
      projectId,
      definition: { ...factory.definition, roles: { implement: null } },
      roles: [{ role: "review", file: null }],
    });
  });
});

describe("skillUsers", () => {
  it("lists the roles that bind a skill", () => {
    expect(skillUsers(factory, "review-checklist")).toEqual(["review"]);
    expect(skillUsers(factory, "missing")).toEqual([]);
  });
});
