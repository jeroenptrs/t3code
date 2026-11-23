import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  bindingIssues,
  parseFactoryJson,
  parseRoleFile,
  renderFactoryJson,
  renderRoleFile,
  resolveProjects,
} from "./factoryFiles.ts";
import { rolePresets } from "./roles/index.ts";

const codex = ProviderInstanceId.make("codex");
const provider: ServerProvider = {
  driver: ProviderDriverKind.make("codex"),
  instanceId: codex,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  checkedAt: "2026-11-01T00:00:00Z",
  auth: { status: "authenticated" },
  supportedRuntimeModes: ["approval-required", "full-access"],
  models: [
    {
      slug: "gpt-6",
      name: "GPT-6",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    },
  ],
  skills: [],
  slashCommands: [],
};

describe("parseFactoryJson", () => {
  it("reads a complete definition and ignores the trigger list older files have", () => {
    const text = JSON.stringify({
      version: 2,
      name: "triage",
      projects: ["backend", "frontend"],
      triggers: [{ kind: "scheduled_task", scheduledTaskId: "scheduled-task:nightly" }],
      roles: { foreman: "roles/foreman.md", review: "prompts/reviewer.md", analysis: null },
    });
    expect(parseFactoryJson("triage", text)).toEqual({
      definition: {
        version: 2,
        name: "triage",
        projects: ["backend", "frontend"],
        roles: { foreman: "roles/foreman.md", review: "prompts/reviewer.md", analysis: null },
      },
      issues: [],
    });
  });

  it("reads missing lists as empty", () => {
    expect(parseFactoryJson("triage", '{ "version": 2, "name": "triage" }')).toEqual({
      definition: { version: 2, name: "triage", projects: [], roles: {} },
      issues: [],
    });
  });

  it("gives a file without a version implement and review, at their default files if they exist", () => {
    const text = JSON.stringify({ name: "triage", roles: { review: "prompts/reviewer.md" } });
    expect(parseFactoryJson("triage", text, (role) => role !== "implement").definition).toEqual({
      version: 2,
      name: "triage",
      projects: [],
      roles: {
        review: "prompts/reviewer.md",
        foreman: "roles/foreman.md",
        implement: null,
      },
    });
    expect(parseFactoryJson("triage", '{ "name": "triage" }').definition.roles).toEqual({
      implement: null,
      review: null,
    });
  });

  it("leaves out a role with a reserved or malformed name, or a bad path, and reports it", () => {
    const text = JSON.stringify({
      version: 2,
      name: "triage",
      roles: { waiting: null, "Bad Name": null, docs: "../docs.md", notes: null },
    });
    const parsed = parseFactoryJson("triage", text);
    expect(parsed.definition.roles).toEqual({ notes: null });
    expect(parsed.issues.map((issue) => [issue.code, issue.role, issue.field])).toEqual([
      ["invalid_definition", null, "roles"],
      ["invalid_definition", null, "roles"],
      ["invalid_definition", "docs", "roles"],
    ]);
  });

  it.each([
    ["not JSON", "{ name: triage", [["invalid_definition", null]]],
    ["not an object", "[]", [["invalid_definition", null]]],
    ["another factory's name", '{ "name": "other" }', [["name_mismatch", "name"]]],
    ["an invalid name", '{ "name": "Bad Name" }', [["name_mismatch", "name"]]],
    [
      "a role path outside the factory directory",
      '{ "name": "triage", "roles": { "foreman": "../../AGENTS.md" } }',
      [["invalid_definition", "roles"]],
    ],
  ])("reports %s and keeps the directory's name", (_case, text, expected) => {
    const parsed = parseFactoryJson("triage", text);
    expect(parsed.definition.name).toBe("triage");
    expect(Object.values(parsed.definition.roles)).not.toContainEqual(expect.any(String));
    expect(parsed.issues.map((issue) => [issue.code, issue.field])).toEqual(expected);
  });

  it("writes what it reads", () => {
    const definition = {
      version: 2 as const,
      name: "triage",
      projects: ["backend"],
      roles: { implement: "roles/implement.md", docs: null },
    };
    expect(parseFactoryJson("triage", renderFactoryJson(definition))).toEqual({
      definition,
      issues: [],
    });
  });
});

describe("parseRoleFile", () => {
  it("reads the bindings from the frontmatter and the instructions after it", () => {
    const text = [
      "---",
      "model:",
      "  instanceId: codex",
      "  model: gpt-6",
      "runtimeMode: approval-required",
      "enabled: false",
      "skills: [triage-jira]",
      "---",
      "",
      "Route every issue to implement.",
      "",
    ].join("\n");
    expect(parseRoleFile("foreman", text)).toEqual({
      binding: {
        model: { instanceId: codex, model: "gpt-6" },
        runtimeMode: "approval-required",
        enabled: false,
        skills: ["triage-jira"],
      },
      body: "Route every issue to implement.",
      issues: [],
    });
  });

  it.each([
    ["no frontmatter", "Just instructions.\n", {}, "Just instructions."],
    ["frontmatter and no body", "---\nisolation: shared\n---\n", { isolation: "shared" }, null],
    ["an empty frontmatter", "---\n---\n\nBody.\n", {}, "Body."],
    ["an empty file", "", {}, null],
  ])("reads %s", (_case, text, binding, body) => {
    expect(parseRoleFile("implement", text)).toEqual({ binding, body, issues: [] });
  });

  it("drops each bad binding and keeps the rest", () => {
    const text = "---\nruntime_mode: auto\nruntimeMode: yolo\nisolation: worktree\n---\nBody.";
    const parsed = parseRoleFile("review", text);
    expect(parsed.binding).toEqual({ isolation: "worktree" });
    expect(parsed.issues.map((issue) => [issue.code, issue.role, issue.field])).toEqual([
      ["invalid_binding", "review", "runtime_mode"],
      ["invalid_binding", "review", "runtimeMode"],
    ]);
  });

  it.each([
    ["frontmatter that is not YAML", "---\nmodel: [unclosed\n---\nBody."],
    ["frontmatter that is a list", "---\n- model\n---\nBody."],
  ])("reports %s and keeps the body", (_case, text) => {
    const parsed = parseRoleFile("review", text);
    expect(parsed.binding).toEqual({});
    expect(parsed.body).toBe("Body.");
    expect(parsed.issues.map((issue) => issue.code)).toEqual(["invalid_role_file"]);
  });

  it.each([
    [
      "bindings and a body",
      { model: { instanceId: codex, model: "gpt-6" }, tools: ["Read"] },
      "Review the diff.",
    ],
    ["a body that opens with a horizontal rule", {}, "---\n\nBelow the rule."],
    ["no body", { isolation: "shared" as const }, null],
  ])("writes what it reads for %s", (_case, binding, body) => {
    expect(parseRoleFile("review", renderRoleFile(binding, body))).toEqual({
      binding,
      body,
      issues: [],
    });
  });
});

describe("bindingIssues", () => {
  const withModel = (model: string, extra: object = {}) => ({
    ...rolePresets.implement.binding,
    model: { instanceId: codex, model },
    ...extra,
  });

  it.each([
    ["a known model", withModel("gpt-6"), []],
    ["the project's default model", rolePresets.implement.binding, []],
    [
      "an unknown provider instance",
      { ...withModel("gpt-6"), model: { instanceId: ProviderInstanceId.make("x"), model: "m" } },
      [["unknown_provider_instance", "model"]],
    ],
    ["an unknown model", withModel("gpt-1"), [["unknown_model", "model"]]],
    [
      "an option the model does not offer",
      {
        ...withModel("gpt-6"),
        model: { ...withModel("gpt-6").model, options: [{ id: "effort", value: "max" }] },
      },
      [["invalid_model_options", "model"]],
    ],
    [
      "a runtime mode the provider does not support",
      withModel("gpt-6", { runtimeMode: "auto" }),
      [["unsupported_runtime_mode", "runtimeMode"]],
    ],
  ])("checks %s", (_case, binding, expected) => {
    expect(
      bindingIssues("implement", binding, [provider]).map((issue) => [issue.code, issue.field]),
    ).toEqual(expected);
  });
});

describe("resolveProjects", () => {
  it("resolves names by title and reports unknown and ambiguous ones", () => {
    const backend = ProjectId.make("project-backend");
    const projects = [
      { projectId: backend, title: "backend" },
      { projectId: ProjectId.make("project-site-1"), title: "site" },
      { projectId: ProjectId.make("project-site-2"), title: "site" },
    ];
    const resolved = resolveProjects(["backend", "site", "mobile"], projects);
    expect(resolved.projects).toEqual([
      { name: "backend", projectId: backend },
      { name: "site", projectId: null },
      { name: "mobile", projectId: null },
    ]);
    expect(resolved.issues.map((issue) => issue.code)).toEqual([
      "ambiguous_project",
      "unknown_project",
    ]);
  });
});
