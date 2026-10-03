import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { branchOptions, type T3Transport } from "@t3tools/integration-runtime";
import * as Effect from "effect/Effect";

import {
  buildSetupView,
  buildLoadingSetupView,
  loadBranchCatalog,
  loadModelOptions,
  loadSetupCatalog,
  modelSlackOptionGroups,
  SETUP_BRANCH_ACTION,
  SETUP_MODEL_ACTION,
  SETUP_PROJECT_ACTION,
  SETUP_WORKSPACE_ACTION,
  SLACK_PROMPT_MAX_LENGTH,
  type SetupCatalog,
} from "./setup.ts";

const catalog = {
  project: {
    id: ProjectId.make("project-a"),
    title: "Project A",
    workspaceRoot: "/repo",
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    },
    scripts: [],
  },
  projects: [{ value: "project-a", label: "Project A", description: "/repo" }],
  refs: {
    isRepo: true,
    hasPrimaryRemote: true,
    nextCursor: null,
    totalCount: 2,
    refs: [
      { name: "main", current: true, isDefault: true, worktreePath: "/repo" },
      {
        name: "feature/a",
        current: false,
        isDefault: false,
        worktreePath: "/repo/.t3/worktrees/a",
      },
    ],
  },
  models: [
    {
      value: "m:0000000000000000000000",
      label: "GPT-5 · High",
      group: "Codex",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      isDefault: true,
    },
  ],
  defaultModelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5",
  },
} as unknown as SetupCatalog;

describe("Slack custom setup view", () => {
  it("opens a lightweight prompt-visible loading modal without hiding the prompt in metadata", () => {
    const view = buildLoadingSetupView({
      origin: {
        invocation: {
          identityVersion: 1,
          integration: "slack",
          tenantId: "T1",
          surface: "custom-slash",
          invocationId: "opaque",
        },
        response: { kind: "message", channelId: "C1" },
      },
      prompt: "Inspect CI",
    });
    expect(view.blocks[0]?.text.text).toBe("Inspect CI");
    expect(view.private_metadata).not.toContain("Inspect CI");
  });

  it("renders exactly the four locked selectors plus the visible prompt", () => {
    const view = buildSetupView({
      origin: {
        invocation: {
          identityVersion: 1,
          integration: "slack",
          tenantId: "T1",
          surface: "custom-slash",
          invocationId: "opaque",
        },
        response: { kind: "message", channelId: "C1" },
      },
      prompt: "Inspect CI",
      catalog,
    });
    const actions = view.blocks.map((block) => block.element.action_id);
    expect(actions).toEqual([
      "t3_setup_prompt",
      SETUP_PROJECT_ACTION,
      SETUP_WORKSPACE_ACTION,
      SETUP_BRANCH_ACTION,
      SETUP_MODEL_ACTION,
    ]);
    expect(view.blocks.filter((block) => block.element.type.endsWith("select"))).toHaveLength(4);
    expect(view.private_metadata).not.toContain("Inspect CI");
    expect(view.blocks[0]?.element).toMatchObject({
      min_length: 1,
      max_length: SLACK_PROMPT_MAX_LENGTH,
    });
    expect(view.blocks[1]?.element).toMatchObject({ type: "external_select" });
  });

  it("rotates dependent block identities when Project or Workspace changes", () => {
    const current = buildSetupView({
      origin: {
        invocation: {
          identityVersion: 1,
          integration: "slack",
          tenantId: "T1",
          surface: "dm",
          invocationId: "D1:1",
        },
        response: { kind: "message", channelId: "D1" },
      },
      prompt: "Inspect CI",
      catalog,
      workspace: "current",
    });
    const nextWorkspace = buildSetupView({
      origin: {
        invocation: {
          identityVersion: 1,
          integration: "slack",
          tenantId: "T1",
          surface: "dm",
          invocationId: "D1:1",
        },
        response: { kind: "message", channelId: "D1" },
      },
      prompt: "Inspect CI",
      catalog,
      workspace: "new-worktree",
    });
    const branchBlock = (view: typeof current) =>
      view.blocks.find((block) => block.element.action_id === SETUP_BRANCH_ACTION)?.block_id;
    expect(branchBlock(current)).not.toBe(branchBlock(nextWorkspace));
  });

  it("groups model options by provider", () => {
    const groups = modelSlackOptionGroups(
      [
        ...catalog.models,
        {
          ...catalog.models[0]!,
          value: "m:1111111111111111111111",
          group: "Cursor",
          label: "Cursor · High",
        },
      ],
      "",
    );
    expect(groups.map((group) => group.label.text)).toEqual(["Codex", "Cursor"]);
  });

  it("limits configurable provider group labels to Slack's 75-character maximum", () => {
    const groups = modelSlackOptionGroups(
      [{ ...catalog.models[0]!, group: "Provider ".repeat(20) }],
      "",
    );
    expect(groups[0]?.label.text).toHaveLength(75);
  });

  it.effect("loads branch options without waiting for provider configuration", () =>
    Effect.gen(function* () {
      let configRequested = false;
      const transport = {
        getShellSnapshot: () => Effect.succeed({ projects: [catalog.project] } as never),
        getServerConfig: () => {
          configRequested = true;
          return Effect.die("branch loading must not request provider config");
        },
        listRefs: () => Effect.succeed(catalog.refs),
      } as unknown as T3Transport;
      const result = yield* loadBranchCatalog({
        transport,
        projectId: catalog.project.id,
        query: "main",
      });
      expect(result.refs).toBe(catalog.refs);
      expect(configRequested).toBe(false);
    }),
  );

  it.effect("loads model options without waiting for Git refs", () =>
    Effect.gen(function* () {
      let refsRequested = false;
      const transport = {
        getShellSnapshot: () => Effect.succeed({ projects: [catalog.project] } as never),
        getServerConfig: () =>
          Effect.succeed({
            providers: [
              {
                instanceId: "codex",
                displayName: "Codex",
                enabled: true,
                installed: true,
                availability: "available",
                status: "ready",
                auth: { status: "authenticated" },
                models: [{ slug: "gpt-5", name: "GPT-5" }],
              },
            ],
          } as never),
        listRefs: () => {
          refsRequested = true;
          return Effect.die("model loading must not request refs");
        },
      } as unknown as T3Transport;
      const result = yield* loadModelOptions({
        transport,
        projectId: catalog.project.id,
        integrationDefault: catalog.defaultModelSelection,
      });
      expect(result).toHaveLength(1);
      expect(refsRequested).toBe(false);
    }),
  );

  it.effect("returns a terminal project error only when no setup project survives", () =>
    Effect.gen(function* () {
      const transport = {
        getShellSnapshot: () => Effect.succeed({ projects: [] } as never),
        getServerConfig: () => Effect.succeed({ providers: [] } as never),
        listRefs: () => Effect.die("refs must not load without a project"),
      } as unknown as T3Transport;
      const error = yield* loadSetupCatalog({
        transport,
        projectId: "deleted-project",
        integrationDefault: null,
        fallbackToFirstProject: true,
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "project_not_found" });
      expect(error.message).toContain("No T3 Code projects");
    }),
  );

  it("keeps all four selectors for a non-repository and limits Workspace to Current", () => {
    const nonRepository = {
      ...catalog,
      refs: {
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
        refs: [],
      },
    } as unknown as SetupCatalog;
    const view = buildSetupView({
      origin: {
        invocation: {
          identityVersion: 1,
          integration: "slack",
          tenantId: "T1",
          surface: "dm",
          invocationId: "D1:1",
        },
        response: { kind: "message", channelId: "D1" },
      },
      prompt: "Inspect CI",
      catalog: nonRepository,
    });
    const workspace = view.blocks.find(
      (block) => block.element.action_id === SETUP_WORKSPACE_ACTION,
    );
    const branch = view.blocks.find((block) => block.element.action_id === SETUP_BRANCH_ACTION);
    expect(workspace?.element).toMatchObject({ options: [{ value: "current" }] });
    expect(branch?.element).toMatchObject({
      options: [{ value: "no-repository" }],
    });
  });

  it("keeps Branch rendered in New worktree mode and defaults it to the repository default", () => {
    const view = buildSetupView({
      origin: {
        invocation: {
          identityVersion: 1,
          integration: "slack",
          tenantId: "T1",
          surface: "dm",
          invocationId: "D1:1",
        },
        response: { kind: "message", channelId: "D1" },
      },
      prompt: "Inspect CI",
      catalog,
      workspace: "new-worktree",
    });
    const branch = view.blocks.find((block) => block.element.action_id === SETUP_BRANCH_ACTION);
    expect(branch?.element).toMatchObject({
      initial_option: { value: branchOptions(catalog.refs)[0]?.value },
    });
  });
});
