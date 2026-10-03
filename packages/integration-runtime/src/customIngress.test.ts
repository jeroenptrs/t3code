import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationV2ThreadLaunchInput,
  type ServerConfig,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { startCustomIngress } from "./customIngress.ts";
import { deriveIngressIds } from "./identity.ts";
import { branchOptions, encodeBranchSelectionOption, modelEffortOptions } from "./selectors.ts";
import { launchResult, projectShell, shellSnapshot, threadSnapshot } from "./testFixtures.ts";
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
const shell = shellSnapshot(1, [
  projectShell(projectId, {
    title: "Project A",
    workspaceRoot: "/repo",
    defaultModelSelection: projectDefault,
  }),
]);
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

const ids = deriveIngressIds(invocation);

/** `calls` records checkout switches and launches in the order they reached the server. */
const makeTransport = (refResult: VcsListRefsResult, options?: { readonly resumed?: boolean }) => {
  const launched: Array<OrchestrationV2ThreadLaunchInput> = [];
  const switches: Array<{ readonly cwd: string; readonly refName: string }> = [];
  const calls: Array<"switchRef" | "launchThread"> = [];
  const transport: T3Transport = {
    close: () => Effect.void,
    validateSession: () => Effect.die("not used"),
    getShellSnapshot: () => Effect.succeed(shell),
    subscribeShell: () => Stream.never,
    getServerConfig: () => Effect.succeed(config),
    getThreadSnapshot: () => Effect.succeed(null),
    listRefs: () => Effect.succeed(refResult),
    subscribeVcsStatus: () => Stream.never,
    switchRef: (input) =>
      Effect.sync(() => {
        calls.push("switchRef");
        switches.push({ cwd: input.cwd, refName: input.refName });
        return { refName: input.refName };
      }),
    launchThread: (launch) =>
      Effect.sync(() => {
        calls.push("launchThread");
        launched.push(launch);
        return launchResult({
          threadId: ids.threadId,
          projectId: launch.projectId,
          modelSelection: launch.modelSelection,
          messageIds: [ids.messageId],
          resumed: options?.resumed ?? false,
        });
      }),
  };
  return { transport, launched, switches, calls };
};

/** A thread the first attempt created without ever recording its message. */
const partialThread = () =>
  threadSnapshot({
    threadId: ids.threadId,
    projectId,
    modelSelection: selectedModel().modelSelection,
  });

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

const start = (
  transport: T3Transport,
  selection: Parameters<typeof startCustomIngress>[0]["selection"],
) =>
  startCustomIngress({
    invocation,
    selection,
    integrationDefault: null,
    requestedAt: "2026-08-01T00:00:00.000Z",
    publicBaseUrl: "https://t3.example",
    transport,
  });

describe("custom ingress targeting", () => {
  it.effect("switches the root checkout to the selected branch before launching on it", () =>
    Effect.gen(function* () {
      const { transport, launched, switches, calls } = makeTransport(refs());
      const result = yield* start(transport, {
        projectId,
        workspace: "current",
        branch: selectedBranch(refs()),
        modelOption: selectedModel().value,
      });
      expect(result.recovery).toBe("created");
      expect(switches).toEqual([{ cwd: "/repo", refName: "main" }]);
      expect(calls).toEqual(["switchRef", "launchThread"]);
      expect(launched[0]?.workspaceStrategy).toEqual({ type: "root", branch: "main" });
    }),
  );

  it.effect("continues in the exact existing worktree without switching", () =>
    Effect.gen(function* () {
      const { transport, launched, switches } = makeTransport(refs("/repo/.t3/worktrees/main"));
      yield* start(transport, {
        projectId,
        workspace: "current",
        branch: selectedBranch(refs("/repo/.t3/worktrees/main")),
        modelOption: selectedModel().value,
      });
      expect(switches).toEqual([]);
      expect(launched[0]?.workspaceStrategy).toEqual({
        type: "existing_worktree",
        worktreePath: "/repo/.t3/worktrees/main",
        branch: "main",
      });
    }),
  );

  it.effect("launches New worktree from the selected base and leaves naming to the server", () =>
    Effect.gen(function* () {
      const { transport, launched, switches } = makeTransport(refs());
      yield* start(transport, {
        projectId,
        workspace: "new-worktree",
        branch: selectedBranch(refs()),
        modelOption: selectedModel().value,
      });
      expect(switches).toEqual([]);
      expect(launched).toHaveLength(1);
      expect(launched[0]).toMatchObject({
        commandId: ids.launchCommandId,
        threadId: ids.threadId,
        initialMessage: { messageId: ids.messageId, text: "Implement the feature" },
        modelSelection: selectedModel().modelSelection,
      });
      expect(launched[0]?.workspaceStrategy).toEqual({
        type: "worktree",
        baseRef: "main",
        startFromOrigin: true,
      });
    }),
  );

  it.effect("launches on the project root when the project is not a repository", () =>
    Effect.gen(function* () {
      const notRepo: VcsListRefsResult = { ...refs(), isRepo: false, refs: [], totalCount: 0 };
      const { transport, launched, switches } = makeTransport(notRepo);
      yield* start(transport, {
        projectId,
        workspace: "current",
        branch: null,
        modelOption: selectedModel().value,
      });
      expect(switches).toEqual([]);
      expect(launched[0]?.workspaceStrategy).toEqual({ type: "root" });

      const error = yield* start(transport, {
        projectId,
        workspace: "new-worktree",
        branch: null,
        modelOption: selectedModel().value,
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "invalid_request" });
      expect(launched).toHaveLength(1);
    }),
  );

  it.effect("rejects a changed branch-to-worktree mapping before creating a thread", () =>
    Effect.gen(function* () {
      const { transport, launched, switches } = makeTransport(refs());
      const error = yield* start(transport, {
        projectId,
        workspace: "current",
        branch: encodeBranchSelectionOption({
          name: "main",
          current: false,
          isDefault: false,
          worktreePath: "/repo/.t3/worktrees/deleted-main",
        }),
        modelOption: selectedModel().value,
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "invalid_request" });
      expect(launched).toEqual([]);
      expect(switches).toEqual([]);
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
      const { transport: base, launched } = makeTransport(refs());
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
      yield* start(transport, {
        projectId,
        workspace: "current",
        branch: encodeBranchSelectionOption(target),
        modelOption: selectedModel().value,
      });
      expect(cursors).toEqual([undefined, 200]);
      expect(launched[0]?.workspaceStrategy).toMatchObject({
        type: "existing_worktree",
        worktreePath: target.worktreePath,
      });
    }),
  );

  it.effect("relaunches a partial Current root conversation and reports the resume", () =>
    Effect.gen(function* () {
      const { transport: base, launched, calls } = makeTransport(refs(), { resumed: true });
      const transport: T3Transport = {
        ...base,
        getThreadSnapshot: () => Effect.succeed(partialThread()),
      };
      const result = yield* start(transport, {
        projectId,
        workspace: "current",
        branch: selectedBranch(refs()),
        modelOption: selectedModel().value,
      });
      expect(result.recovery).toBe("resumed");
      expect(calls).toEqual(["switchRef", "launchThread"]);
      expect(launched[0]).toMatchObject({
        commandId: ids.launchCommandId,
        workspaceStrategy: { type: "root", branch: "main" },
      });
    }),
  );

  it.effect("rejects changing the project of a partial Current conversation", () =>
    Effect.gen(function* () {
      const projectB = projectShell("project-b", {
        title: "Project B",
        workspaceRoot: "/repo-b",
        defaultModelSelection: projectDefault,
      });
      const refsB = {
        ...refs(),
        refs: [{ ...refs().refs[0]!, name: "branch-b", worktreePath: "/repo-b" }],
      };
      const { transport: base, launched, switches } = makeTransport(refsB);
      const transport: T3Transport = {
        ...base,
        getShellSnapshot: () =>
          Effect.succeed({ ...shell, projects: [...shell.projects, projectB] }),
        getThreadSnapshot: () => Effect.succeed(partialThread()),
      };
      const error = yield* start(transport, {
        projectId: projectB.id,
        workspace: "current",
        branch: selectedBranch(refsB),
        modelOption: selectedModel().value,
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "invalid_request" });
      expect(launched).toEqual([]);
      expect(switches).toEqual([]);
    }),
  );

  it.effect("rejects changing the model of a partial Current conversation", () =>
    Effect.gen(function* () {
      const { transport: base, launched, switches } = makeTransport(refs());
      const transport: T3Transport = {
        ...base,
        getThreadSnapshot: () => Effect.succeed(partialThread()),
      };
      const differentModel = modelEffortOptions({
        config,
        project: shell.projects[0]!,
        integrationDefault: null,
      })[0]!;
      const error = yield* start(transport, {
        projectId,
        workspace: "current",
        branch: selectedBranch(refs()),
        modelOption: differentModel.value,
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "invalid_request" });
      expect(launched).toEqual([]);
      expect(switches).toEqual([]);
    }),
  );
});
