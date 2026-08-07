import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ClientOrchestrationCommand,
  type ModelSelection,
  type OrchestrationShellSnapshot,
  type ServerConfig,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { startCustomIngress } from "./customIngress.ts";
import { deriveIngressIds } from "./identity.ts";
import { branchOptions, encodeBranchSelectionOption, modelEffortOptions } from "./selectors.ts";
import type { T3Transport } from "./transport.ts";

const projectId = ProjectId.make("project-a");
const invocation = {
  identityVersion: 1 as const,
  integration: "slack" as const,
  tenantId: "T1",
  surface: "custom-slash",
  invocationId: "invocation-1",
  prompt: "Implement the feature",
};
const projectDefault: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex-main"),
  model: "model-a",
  options: [
    { id: "reasoningEffort", value: "high" },
    { id: "fastMode", value: true },
  ],
};
const shell = {
  projects: [
    {
      id: projectId,
      title: "Project A",
      workspaceRoot: "/repo",
      defaultModelSelection: projectDefault,
      scripts: [],
    },
  ],
} as unknown as OrchestrationShellSnapshot;
const config = {
  environment: { environmentId: EnvironmentId.make("env-a") },
  settings: { newWorktreesStartFromOrigin: true },
  providers: [
    {
      instanceId: ProviderInstanceId.make("codex-main"),
      driver: "codex",
      displayName: "Codex",
      enabled: true,
      installed: true,
      availability: "available",
      status: "ready",
      auth: { status: "authenticated" },
      models: [
        {
          slug: "model-a",
          name: "Model A",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Effort",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "high", label: "High", isDefault: true },
                ],
              },
              { id: "fastMode", label: "Fast", type: "boolean", currentValue: false },
            ],
          },
        },
        { slug: "model-b", name: "Model B", isCustom: false, capabilities: null },
      ],
    },
    {
      instanceId: ProviderInstanceId.make("disabled"),
      driver: "codex",
      enabled: false,
      installed: true,
      status: "disabled",
      auth: { status: "authenticated" },
      models: [{ slug: "hidden", name: "Hidden", isCustom: false, capabilities: null }],
    },
  ],
} as unknown as ServerConfig;

const refs = (worktreePath: string | null = null): VcsListRefsResult => ({
  isRepo: true,
  hasPrimaryRemote: true,
  nextCursor: null,
  totalCount: 1,
  refs: [
    {
      name: "main",
      current: worktreePath === null,
      isDefault: true,
      worktreePath,
    },
  ],
});

const makeTransport = (refResult: VcsListRefsResult) => {
  const commands: Array<ClientOrchestrationCommand> = [];
  const switches: Array<string> = [];
  const bootstraps: Array<ClientOrchestrationCommand> = [];
  const transport: T3Transport = {
    close: () => Effect.void,
    validateSession: () => Effect.die("not used"),
    getShellSnapshot: () => Effect.succeed(shell),
    subscribeShell: () => Stream.never,
    getServerConfig: () => Effect.succeed(config),
    getThreadSnapshot: () => Effect.succeed(null),
    listRefs: () => Effect.succeed(refResult),
    subscribeVcsStatus: () => Stream.never,
    switchRef: (input) => {
      switches.push(input.refName);
      return Effect.succeed({ refName: input.refName });
    },
    dispatch: (command) => {
      commands.push(command);
      return Effect.succeed({ sequence: commands.length });
    },
    dispatchBootstrap: (command) => {
      bootstraps.push(command);
      return Effect.succeed({ sequence: 1 });
    },
  };
  return { transport, commands, switches, bootstraps };
};

const selectedModel = () =>
  modelEffortOptions({ config, project: shell.projects[0]!, integrationDefault: null })[1]!;
const selectedBranch = (result: VcsListRefsResult) => branchOptions(result)[0]!.value;

describe("custom ingress selectors", () => {
  it("builds a ragged per-model effort matrix and preserves non-effort defaults", () => {
    const options = modelEffortOptions({
      config,
      project: shell.projects[0]!,
      integrationDefault: null,
    });
    expect(options.map((option) => option.label)).toEqual([
      "Model A · Low",
      "Model A · High",
      "Model B",
    ]);
    expect(options[0]?.modelSelection.options).toEqual([
      { id: "fastMode", value: true },
      { id: "reasoningEffort", value: "low" },
    ]);
    expect(options.filter((option) => option.isDefault).map((option) => option.label)).toEqual([
      "Model A · High",
      "Model B",
    ]);
  });

  it("keeps Slack values compact and excludes absolute worktree paths", () => {
    const branch = branchOptions(refs("/very/long/absolute/path/to/a/private/worktree"))[0]!;
    expect(branch.value).toMatch(/^b:[A-Za-z0-9_-]{22}$/);
    expect(branch.value).not.toContain("/very/long");
    expect(branch.value.length).toBeLessThanOrEqual(75);
    expect(selectedModel().value).toMatch(/^m:[A-Za-z0-9_-]{22}$/);
    expect(selectedModel().value.length).toBeLessThanOrEqual(75);
  });

  it("projects Cursor reasoning and OpenCode variant as per-model effort choices", () => {
    const providers = [
      {
        ...config.providers[0],
        instanceId: ProviderInstanceId.make("cursor"),
        displayName: "Cursor",
        models: [
          {
            slug: "cursor-model",
            name: "Cursor Model",
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoning",
                  label: "Reasoning",
                  type: "select",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "high", label: "High", isDefault: true },
                  ],
                },
                {
                  id: "contextWindow",
                  label: "Context",
                  type: "select",
                  options: [{ id: "large", label: "Large", isDefault: true }],
                },
              ],
            },
          },
        ],
      },
      {
        ...config.providers[0],
        instanceId: ProviderInstanceId.make("opencode"),
        displayName: "OpenCode",
        models: [
          {
            slug: "open-model",
            name: "Open Model",
            capabilities: {
              optionDescriptors: [
                {
                  id: "variant",
                  label: "Variant",
                  type: "select",
                  options: [
                    { id: "fast", label: "Fast" },
                    { id: "deep", label: "Deep", isDefault: true },
                  ],
                },
                {
                  id: "agent",
                  label: "Agent",
                  type: "select",
                  options: [{ id: "build", label: "Build", isDefault: true }],
                },
              ],
            },
          },
        ],
      },
    ] as unknown as ServerConfig["providers"];
    const options = modelEffortOptions({
      config: { ...config, providers },
      project: shell.projects[0]!,
      integrationDefault: null,
    });
    expect(options.map((option) => option.label)).toEqual([
      "Cursor Model · Low",
      "Cursor Model · High",
      "Open Model · Fast",
      "Open Model · Deep",
    ]);
  });
});

describe("custom ingress targeting", () => {
  it.effect("atomically bootstraps the root checkout switch and start", () =>
    Effect.gen(function* () {
      const { transport, commands, switches, bootstraps } = makeTransport(refs());
      yield* startCustomIngress({
        invocation,
        selection: {
          projectId,
          workspace: "current",
          branch: selectedBranch(refs()),
          modelOption: selectedModel().value,
        },
        integrationDefault: null,
        requestedAt: "2026-08-01T00:00:00.000Z",
        publicBaseUrl: "https://t3.example",
        transport,
      });
      expect(switches).toEqual([]);
      expect(commands).toEqual([]);
      expect(bootstraps[0]).toMatchObject({
        bootstrap: {
          switchRef: { cwd: "/repo", refName: "main" },
          createThread: { branch: "main", worktreePath: null },
        },
      });
    }),
  );

  it.effect("continues in the exact existing worktree without switching", () =>
    Effect.gen(function* () {
      const { transport, commands, switches } = makeTransport(refs("/repo/.t3/worktrees/main"));
      yield* startCustomIngress({
        invocation,
        selection: {
          projectId,
          workspace: "current",
          branch: selectedBranch(refs("/repo/.t3/worktrees/main")),
          modelOption: selectedModel().value,
        },
        integrationDefault: null,
        requestedAt: "2026-08-01T00:00:00.000Z",
        publicBaseUrl: "https://t3.example",
        transport,
      });
      expect(switches).toEqual([]);
      expect(commands[0]).toMatchObject({ worktreePath: "/repo/.t3/worktrees/main" });
    }),
  );

  it.effect(
    "dispatches New worktree through WS bootstrap with deterministic branch and setup",
    () =>
      Effect.gen(function* () {
        const { transport, commands, bootstraps } = makeTransport(refs());
        yield* startCustomIngress({
          invocation,
          selection: {
            projectId,
            workspace: "new-worktree",
            branch: selectedBranch(refs()),
            modelOption: selectedModel().value,
          },
          integrationDefault: null,
          requestedAt: "2026-08-01T00:00:00.000Z",
          publicBaseUrl: "https://t3.example",
          transport,
        });
        expect(commands).toEqual([]);
        expect(bootstraps[0]).toMatchObject({
          commandId: deriveIngressIds(invocation).startCommandId,
          bootstrap: {
            prepareWorktree: {
              baseBranch: "main",
              branch: expect.stringMatching(/^t3code\/[0-9a-f]{8}$/),
              startFromOrigin: true,
            },
            runSetupScript: true,
          },
        });
        const bootstrap = bootstraps[0];
        if (bootstrap?.type !== "thread.turn.start" || !bootstrap.bootstrap?.createThread) {
          throw new Error("Expected New-worktree bootstrap");
        }
        expect(bootstrap.bootstrap.createThread.branch).toBe(
          bootstrap.bootstrap.prepareWorktree?.branch,
        );
      }),
  );

  it.effect("rejects a changed branch-to-worktree mapping before creating a thread", () =>
    Effect.gen(function* () {
      const { transport, commands, switches, bootstraps } = makeTransport(refs());
      const result = yield* Effect.result(
        startCustomIngress({
          invocation,
          selection: {
            projectId,
            workspace: "current",
            branch: encodeBranchSelectionOption({
              name: "main",
              current: false,
              isDefault: false,
              worktreePath: "/repo/.t3/worktrees/deleted-main",
            }),
            modelOption: selectedModel().value,
          },
          integrationDefault: null,
          requestedAt: "2026-08-01T00:00:00.000Z",
          publicBaseUrl: "https://t3.example",
          transport,
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(commands).toEqual([]);
      expect(switches).toEqual([]);
      expect(bootstraps).toEqual([]);
    }),
  );

  it.effect("paginates until an exact compact branch identity is found", () =>
    Effect.gen(function* () {
      const target = {
        name: "feature/after-page-200",
        current: false,
        isDefault: false,
        worktreePath: "/repo/.t3/worktrees/after-page-200",
      };
      const { transport: base, commands } = makeTransport(refs());
      const cursors: Array<number | undefined> = [];
      const transport: T3Transport = {
        ...base,
        listRefs: (input) => {
          cursors.push(input.cursor);
          return Effect.succeed(
            input.cursor === 200
              ? { ...refs(), refs: [target], nextCursor: null, totalCount: 201 }
              : { ...refs(), refs: refs().refs, nextCursor: 200, totalCount: 201 },
          );
        },
      };
      yield* startCustomIngress({
        invocation,
        selection: {
          projectId,
          workspace: "current",
          branch: encodeBranchSelectionOption(target),
          modelOption: selectedModel().value,
        },
        integrationDefault: null,
        requestedAt: "2026-08-01T00:00:00.000Z",
        publicBaseUrl: "https://t3.example",
        transport,
      });
      expect(cursors).toEqual([undefined, 200]);
      expect(commands[0]).toMatchObject({ worktreePath: target.worktreePath });
    }),
  );

  it.effect("does not plain-start a partial New-worktree snapshot", () =>
    Effect.gen(function* () {
      const { transport: base, commands, bootstraps } = makeTransport(refs());
      yield* startCustomIngress({
        invocation,
        selection: {
          projectId,
          workspace: "new-worktree",
          branch: selectedBranch(refs()),
          modelOption: selectedModel().value,
        },
        integrationDefault: null,
        requestedAt: "2026-08-01T00:00:00.000Z",
        publicBaseUrl: "https://t3.example",
        transport: base,
      });
      const initial = bootstraps[0];
      if (initial?.type !== "thread.turn.start" || !initial.bootstrap?.createThread) {
        throw new Error("Expected New-worktree bootstrap");
      }
      const temporaryBranch = initial.bootstrap.createThread.branch;
      bootstraps.length = 0;
      const transport: T3Transport = {
        ...base,
        getThreadSnapshot: () =>
          Effect.succeed({
            thread: {
              id: deriveIngressIds(invocation).threadId,
              projectId,
              messages: [],
              modelSelection: selectedModel().modelSelection,
              title: "Implement the feature",
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: temporaryBranch,
              worktreePath: null,
            },
          } as never),
      };
      const result = yield* startCustomIngress({
        invocation,
        selection: {
          projectId,
          workspace: "new-worktree",
          branch: selectedBranch(refs()),
          modelOption: selectedModel().value,
        },
        integrationDefault: null,
        requestedAt: "2026-08-01T00:00:00.000Z",
        publicBaseUrl: "https://t3.example",
        transport,
      });
      expect(result.recovery).toBe("unverified");
      expect(commands).toEqual([]);
      expect(bootstraps).toEqual([]);
    }),
  );

  it.effect("re-switches a partial Current root snapshot through coordinated bootstrap", () =>
    Effect.gen(function* () {
      const { transport: base, commands, bootstraps } = makeTransport(refs());
      const transport: T3Transport = {
        ...base,
        getThreadSnapshot: () =>
          Effect.succeed({
            thread: {
              id: deriveIngressIds(invocation).threadId,
              projectId,
              messages: [],
              modelSelection: selectedModel().modelSelection,
              title: "Implement the feature",
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "main",
              worktreePath: null,
            },
          } as never),
      };
      const result = yield* startCustomIngress({
        invocation,
        selection: {
          projectId,
          workspace: "current",
          branch: selectedBranch(refs()),
          modelOption: selectedModel().value,
        },
        integrationDefault: null,
        requestedAt: "2026-08-01T00:00:00.000Z",
        publicBaseUrl: "https://t3.example",
        transport,
      });
      expect(result.recovery).toBe("resumed");
      expect(commands).toEqual([]);
      expect(bootstraps[0]).toMatchObject({
        bootstrap: { switchRef: { cwd: "/repo", refName: "main" } },
      });
      const resumed = bootstraps[0];
      if (resumed?.type !== "thread.turn.start") throw new Error("Expected a turn bootstrap");
      expect(resumed.bootstrap).not.toHaveProperty("createThread");
    }),
  );

  it.effect("rejects changing the project of a partial Current conversation", () =>
    Effect.gen(function* () {
      const projectB = {
        ...shell.projects[0]!,
        id: ProjectId.make("project-b"),
        title: "Project B",
        workspaceRoot: "/repo-b",
      };
      const refsB = {
        ...refs(),
        refs: [{ ...refs().refs[0]!, name: "branch-b", worktreePath: "/repo-b" }],
      };
      const { transport: base, commands, bootstraps } = makeTransport(refsB);
      const transport: T3Transport = {
        ...base,
        getShellSnapshot: () =>
          Effect.succeed({ ...shell, projects: [...shell.projects, projectB] } as never),
        getThreadSnapshot: () =>
          Effect.succeed({
            thread: {
              id: deriveIngressIds(invocation).threadId,
              projectId,
              messages: [],
              modelSelection: selectedModel().modelSelection,
              title: "Implement the feature",
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "main",
              worktreePath: null,
            },
          } as never),
      };
      const error = yield* startCustomIngress({
        invocation,
        selection: {
          projectId: projectB.id,
          workspace: "current",
          branch: selectedBranch(refsB),
          modelOption: selectedModel().value,
        },
        integrationDefault: null,
        requestedAt: "2026-08-01T00:00:00.000Z",
        publicBaseUrl: "https://t3.example",
        transport,
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "invalid_request" });
      expect(commands).toEqual([]);
      expect(bootstraps).toEqual([]);
    }),
  );

  it.effect("rejects changing the root branch of a partial Current conversation", () =>
    Effect.gen(function* () {
      const changedRefs = {
        ...refs(),
        totalCount: 2,
        refs: [
          refs().refs[0]!,
          { name: "feature-b", current: false, isDefault: false, worktreePath: null },
        ],
      };
      const { transport: base, commands, bootstraps } = makeTransport(changedRefs);
      const transport: T3Transport = {
        ...base,
        getThreadSnapshot: () =>
          Effect.succeed({
            thread: {
              id: deriveIngressIds(invocation).threadId,
              projectId,
              messages: [],
              modelSelection: selectedModel().modelSelection,
              title: "Implement the feature",
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "main",
              worktreePath: null,
            },
          } as never),
      };
      const error = yield* startCustomIngress({
        invocation,
        selection: {
          projectId,
          workspace: "current",
          branch: branchOptions(changedRefs)[1]!.value,
          modelOption: selectedModel().value,
        },
        integrationDefault: null,
        requestedAt: "2026-08-01T00:00:00.000Z",
        publicBaseUrl: "https://t3.example",
        transport,
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "invalid_request" });
      expect(commands).toEqual([]);
      expect(bootstraps).toEqual([]);
    }),
  );

  it.effect("rejects changing the model of a partial Current conversation", () =>
    Effect.gen(function* () {
      const { transport: base, commands, bootstraps } = makeTransport(refs());
      const transport: T3Transport = {
        ...base,
        getThreadSnapshot: () =>
          Effect.succeed({
            thread: {
              id: deriveIngressIds(invocation).threadId,
              projectId,
              messages: [],
              modelSelection: selectedModel().modelSelection,
              title: "Implement the feature",
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "main",
              worktreePath: null,
            },
          } as never),
      };
      const differentModel = modelEffortOptions({
        config,
        project: shell.projects[0]!,
        integrationDefault: null,
      })[0]!;
      const error = yield* startCustomIngress({
        invocation,
        selection: {
          projectId,
          workspace: "current",
          branch: selectedBranch(refs()),
          modelOption: differentModel.value,
        },
        integrationDefault: null,
        requestedAt: "2026-08-01T00:00:00.000Z",
        publicBaseUrl: "https://t3.example",
        transport,
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "invalid_request" });
      expect(commands).toEqual([]);
      expect(bootstraps).toEqual([]);
    }),
  );

  it.effect("rejects changing an existing-worktree mapping after partial creation", () =>
    Effect.gen(function* () {
      const changedRefs = refs("/repo/.t3/worktrees/new-main");
      const { transport: base, commands, bootstraps } = makeTransport(changedRefs);
      const transport: T3Transport = {
        ...base,
        getThreadSnapshot: () =>
          Effect.succeed({
            thread: {
              id: deriveIngressIds(invocation).threadId,
              projectId,
              messages: [],
              modelSelection: selectedModel().modelSelection,
              title: "Implement the feature",
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "main",
              worktreePath: "/repo/.t3/worktrees/old-main",
            },
          } as never),
      };
      const error = yield* startCustomIngress({
        invocation,
        selection: {
          projectId,
          workspace: "current",
          branch: selectedBranch(changedRefs),
          modelOption: selectedModel().value,
        },
        integrationDefault: null,
        requestedAt: "2026-08-01T00:00:00.000Z",
        publicBaseUrl: "https://t3.example",
        transport,
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "invalid_request" });
      expect(commands).toEqual([]);
      expect(bootstraps).toEqual([]);
    }),
  );
});
