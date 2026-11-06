import {
  AuthEnvironmentMaintainScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthAccessWriteScope,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProjectId,
  ProviderInstanceId,
  SecretProviderId,
  ThreadId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  AuthInsightsReadScope,
  AuthInsightsWriteScope,
  AuthFactoriesManageScope,
  AuthFactoriesReadScope,
  AuthUserRoleScopes,
  FactoryId,
  WorkItemId,
  InsightsContributorId,
  WS_METHODS,
  WsFactoriesRpcGroup,
  WsInsightsRpcGroup,
  WsRpcGroup,
  clientRpcRequiredScopes,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("keeps webhook delivery logs, which hold request bodies, behind operate scope", () => {
    for (const method of [
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      WS_METHODS.scheduledTasksRotateWebhookToken,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("keeps triage, which seeds an agent that reads logs and the database, behind operate scope", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverPrepareTriage)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("requires operate access to browse host folders for a new project", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.filesystemBrowse)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("lets readers watch diff walkthroughs and operators write them", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.diffWalkthroughSubscribe)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.diffWalkthroughPut)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(clientRpcRequiredScopes(WS_METHODS.diffWalkthroughPut, undefined)).toEqual([
      AuthOrchestrationOperateScope,
    ]);
    // Generating runs a model on the environment's providers, which only an operator may start.
    expect(requiredScopeForRpcMethod(WS_METHODS.diffWalkthroughGenerate)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(clientRpcRequiredScopes(WS_METHODS.diffWalkthroughGenerate, undefined)).toEqual([
      AuthOrchestrationOperateScope,
    ]);
  });

  it("lets readers see a Jira proposal's choices and operators decide it", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.jiraCreateMeta)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.jiraDecideProposal)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(clientRpcRequiredScopes(WS_METHODS.jiraDecideProposal, undefined)).toEqual([
      AuthOrchestrationOperateScope,
    ]);
  });

  it("lets only operators comment on, move, plan, or break down a Jira issue", () => {
    for (const method of [
      WS_METHODS.jiraAddComment,
      WS_METHODS.jiraTransitionIssue,
      WS_METHODS.jiraSetSprint,
      WS_METHODS.jiraSetStoryPoints,
      WS_METHODS.jiraStartBreakdown,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
      expect(clientRpcRequiredScopes(method, undefined)).toEqual([AuthOrchestrationOperateScope]);
    }
  });

  it("keeps Insights behind the administrator-only scopes", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.insightsOverview)).toBe(AuthInsightsReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.insightsConfig)).toBe(AuthInsightsReadScope);
    for (const method of [
      WS_METHODS.insightsUpdateSettings,
      WS_METHODS.insightsSetProjectEnabled,
      WS_METHODS.insightsRescanProject,
      WS_METHODS.insightsUpdateContributor,
      WS_METHODS.insightsMergeContributors,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthInsightsWriteScope);
      expect(clientRpcRequiredScopes(method, undefined)).toEqual([AuthInsightsWriteScope]);
    }
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [WS_METHODS.terminalObserve, WS_METHODS.subscribeTerminalMetadata]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalClose,
      WS_METHODS.previewStopLocalServer,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalOperateScope);
    }
  });

  it("lets thread readers observe and refresh checkout branches", () => {
    for (const method of [WS_METHODS.subscribeVcsBranch, WS_METHODS.vcsRefreshBranch]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

describe("RPC scope middleware", () => {
  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }),
  );
});

it.effect.each([WS_METHODS.subscribeVcsBranch, WS_METHODS.subscribeVcsStatus] as const)(
  "enforces read permission on stream %s",
  (method) =>
    Effect.gen(function* () {
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (
            tag,
          ): tag is Exclude<
            keyof typeof RPC_REQUIRED_SCOPES,
            typeof WS_METHODS.subscribeVcsBranch | typeof WS_METHODS.subscribeVcsStatus
          > => tag !== WS_METHODS.subscribeVcsBranch && tag !== WS_METHODS.subscribeVcsStatus,
        ),
      );
      let handled = 0;
      const handlers = Layer.mergeAll(
        group.toLayerHandler(WS_METHODS.subscribeVcsBranch, () =>
          Stream.fromEffect(
            Effect.sync(() => {
              handled++;
              return { refName: "main" };
            }),
          ),
        ),
        group.toLayerHandler(WS_METHODS.subscribeVcsStatus, () =>
          Stream.fromEffect(
            Effect.sync(() => {
              handled++;
            }),
          ).pipe(Stream.drain),
        ),
      );
      const denied = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.merge(handlers, RpcAuthorization.layer([]))),
      );
      expect(
        yield* Stream.runDrain(
          method === WS_METHODS.subscribeVcsBranch
            ? denied[method]({ cwd: "/repo" }).pipe(Stream.drain)
            : denied[method]({ cwd: "/repo" }).pipe(Stream.drain),
        ).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
      expect(handled).toBe(0);
      const granted = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.merge(handlers, RpcAuthorization.layer([AuthOrchestrationReadScope]))),
      );
      yield* Stream.runDrain(
        method === WS_METHODS.subscribeVcsBranch
          ? granted[method]({ cwd: "/repo" }).pipe(Stream.drain)
          : granted[method]({ cwd: "/repo" }).pipe(Stream.drain),
      );
      expect(handled).toBe(1);
    }),
);

describe("Insights authorization", () => {
  const config = {
    settings: {
      startDate: "2026-01-01",
      releaseBranchPatterns: [],
      requestBudgetPerTick: 20,
      updatedAt: null,
    },
    projects: [],
    contributors: [],
  };
  const clientWith = (
    scopes: ReadonlyArray<(typeof AuthUserRoleScopes)["administrator"][number]>,
    handled: Array<string>,
  ) =>
    RpcTest.makeClient(WsInsightsRpcGroup).pipe(
      Effect.provide(
        Layer.mergeAll(
          WsInsightsRpcGroup.toLayer({
            [WS_METHODS.insightsOverview]: () => Effect.die("unused"),
            [WS_METHODS.insightsConfig]: () =>
              Effect.sync(() => handled.push("config")).pipe(Effect.as(config)),
            [WS_METHODS.insightsUpdateSettings]: () => Effect.die("unused"),
            [WS_METHODS.insightsSetProjectEnabled]: () => Effect.die("unused"),
            [WS_METHODS.insightsRescanProject]: () => Effect.die("unused"),
            [WS_METHODS.insightsUpdateContributor]: () =>
              Effect.sync(() => handled.push("update")).pipe(Effect.as(config)),
            [WS_METHODS.insightsMergeContributors]: () => Effect.die("unused"),
          }),
          RpcAuthorization.layer(scopes),
        ),
      ),
    );

  it.effect.each([
    { role: "reader" as const, scopes: AuthUserRoleScopes.reader },
    { role: "operator" as const, scopes: AuthUserRoleScopes.operator },
  ])("refuses a $role before any Insights handler runs", ({ scopes }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* clientWith(scopes, handled);
      expect(yield* client[WS_METHODS.insightsConfig]({}).pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthInsightsReadScope,
      });
      expect(
        yield* client[WS_METHODS.insightsUpdateContributor]({
          contributorId: InsightsContributorId.make("c-1"),
          status: "included",
        }).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthInsightsWriteScope,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("lets an administrator read and change Insights", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* clientWith(AuthUserRoleScopes.administrator, handled);
      yield* client[WS_METHODS.insightsConfig]({});
      yield* client[WS_METHODS.insightsUpdateContributor]({
        contributorId: InsightsContributorId.make("c-1"),
        status: "included",
      });
      expect(handled).toEqual(["config", "update"]);
    }).pipe(Effect.scoped),
  );
});

describe("Factories authorization", () => {
  const factory = {
    id: FactoryId.make("factory:project-1:triage"),
    projectId: ProjectId.make("project-1"),
    name: "triage",
    definition: { name: "triage", projects: [], triggers: [], roles: {} },
    projects: [],
    roles: [],
    skills: [],
    issues: [],
    scheduledTaskIds: [],
    threads: [],
    attention: { gatesWaiting: 0, failedRuns: 0, questions: 0, total: 0 },
  };
  const clientWith = (
    scopes: ReadonlyArray<(typeof AuthUserRoleScopes)["administrator"][number]>,
    handled: Array<string>,
  ) =>
    RpcTest.makeClient(WsFactoriesRpcGroup).pipe(
      Effect.provide(
        Layer.mergeAll(
          WsFactoriesRpcGroup.toLayer({
            [WS_METHODS.factoriesList]: () =>
              Effect.sync(() => handled.push("list")).pipe(Effect.as({ factories: [] })),
            [WS_METHODS.factoriesRead]: () => Effect.die("unused"),
            [WS_METHODS.factoriesSave]: () =>
              Effect.sync(() => handled.push("save")).pipe(Effect.as(factory)),
            [WS_METHODS.factoriesSkillsList]: () =>
              Effect.sync(() => handled.push("skills.list")).pipe(Effect.as({ skills: [] })),
            [WS_METHODS.factoriesSkillsRead]: () => Effect.die("unused"),
            [WS_METHODS.factoriesSkillsSave]: () =>
              Effect.sync(() => handled.push("skills.save")).pipe(Effect.as({ skill })),
            [WS_METHODS.factoriesSkillsDelete]: () =>
              Effect.sync(() => handled.push("skills.delete")).pipe(
                Effect.as({ name: skill.name, source: "home" as const }),
              ),
            [WS_METHODS.factoriesWorkItemsList]: () =>
              Effect.sync(() => handled.push("workItems.list")).pipe(Effect.as({ workItems: [] })),
            [WS_METHODS.factoriesWorkItemsRead]: () => Effect.die("unused"),
            [WS_METHODS.factoriesWorkItemsCreate]: () =>
              Effect.sync(() => handled.push("workItems.create")).pipe(Effect.as(workItem)),
            [WS_METHODS.factoriesWorkItemsAnswerGate]: () =>
              Effect.sync(() => handled.push("workItems.answerGate")).pipe(Effect.as(workItem)),
          }),
          RpcAuthorization.layer(scopes),
        ),
      ),
    );
  const save = { projectId: factory.projectId, definition: factory.definition };
  const skill = { name: "run-checks", source: "home" as const, description: "", replaces: null };
  const skillSave = {
    name: skill.name,
    source: skill.source,
    body: "---\nname: run-checks\n---\n",
  };
  const skillDelete = { name: skill.name, source: skill.source };
  const workItemId = WorkItemId.make("work-item:1");
  const workItem = {
    id: workItemId,
    factoryId: factory.id,
    title: "Fix the login bug",
    source: { kind: "manual" as const, text: "SSO fails." },
    stage: "new" as const,
    gate: { state: "none" as const },
    foremanThreadId: null,
    foremanRunId: null,
    dispatchedAt: null,
    threads: [],
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
    transitions: [],
  };
  const create = { factoryId: factory.id, title: workItem.title, text: workItem.source.text };
  const answer = { workItemId, decision: "approved" as const, note: "" };

  it.effect("refuses a reader before any factory handler runs", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* clientWith(AuthUserRoleScopes.reader, handled);
      expect(yield* client[WS_METHODS.factoriesList]({}).pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthFactoriesReadScope,
      });
      expect(
        yield* client[WS_METHODS.factoriesWorkItemsList]({ factoryId: factory.id }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ requiredPermission: AuthFactoriesReadScope });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("lets an operator view factories and work items but change neither", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* clientWith(AuthUserRoleScopes.operator, handled);
      yield* client[WS_METHODS.factoriesList]({});
      yield* client[WS_METHODS.factoriesWorkItemsList]({ factoryId: factory.id });
      yield* client[WS_METHODS.factoriesSkillsList]({});
      expect(yield* client[WS_METHODS.factoriesSave](save).pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthFactoriesManageScope,
      });
      expect(
        yield* client[WS_METHODS.factoriesSkillsSave](skillSave).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthFactoriesManageScope });
      expect(
        yield* client[WS_METHODS.factoriesSkillsDelete](skillDelete).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthFactoriesManageScope });
      expect(
        yield* client[WS_METHODS.factoriesWorkItemsCreate](create).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthFactoriesManageScope });
      expect(
        yield* client[WS_METHODS.factoriesWorkItemsAnswerGate](answer).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthFactoriesManageScope });
      expect(handled).toEqual(["list", "workItems.list", "skills.list"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "lets an administrator save a factory and its skills, create work items, and answer gates",
    () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* clientWith(AuthUserRoleScopes.administrator, handled);
      yield* client[WS_METHODS.factoriesSave](save);
      yield* client[WS_METHODS.factoriesWorkItemsCreate](create);
      yield* client[WS_METHODS.factoriesWorkItemsAnswerGate](answer);
        yield* client[WS_METHODS.factoriesSkillsSave](skillSave);
        yield* client[WS_METHODS.factoriesSkillsDelete](skillDelete);
        expect(handled).toEqual([
          "save",
          "workItems.create",
          "workItems.answerGate",
          "skills.save",
          "skills.delete",
        ]);
    }).pipe(Effect.scoped),
  );
});

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstanceMutation = {
    operation: "remove" as const,
    instanceId: ProviderInstanceId.make("codex_work"),
  };

  it.effect("allows provider-only mutations while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({ patch: {}, providerInstanceMutation });
      expect(handled).toBe(1);
      yield* client[WS_METHODS.serverUpdateSettings]({
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: ProviderInstanceId.make("codex_work"),
          instance: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              {
                name: "OPENAI_API_KEY",
                sensitive: true,
                value: {
                  provider: SecretProviderId.make("personal"),
                  reference: "op://Private/OpenAI/credential",
                },
              },
            ],
          },
        },
      });
      expect(handled).toBe(2);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access" },
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      // Removing a secret provider clears settings fields that read from it.
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { secretProviders: { [SecretProviderId.make("personal")]: null } },
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(2);
    }),
  );

  it.effect(
    "does not let a settings grant manage providers or turn off T3 Connect device approval",
    () =>
      Effect.gen(function* () {
        let handled = false;
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
                Effect.sync(() => {
                  handled = true;
                  return DEFAULT_SERVER_SETTINGS;
                }),
              ),
              RpcAuthorization.layer([AuthSettingsWriteScope]),
            ),
          ),
        );
        expect(
          yield* client[WS_METHODS.serverUpdateSettings]({
            patch: {},
            providerInstanceMutation,
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
        expect(
          yield* client[WS_METHODS.serverUpdateSettings]({
            patch: { secretProviders: { [SecretProviderId.make("personal")]: null } },
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
        expect(
          yield* client[WS_METHODS.serverUpdateSettings]({
            patch: { requireConnectDeviceApproval: false },
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthAccessWriteScope });
        expect(handled).toBe(false);
      }),
  );
});

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }),
);

describe("thread context authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.gitRunStackedAction> =>
        tag !== WS_METHODS.gitRunStackedAction,
    ),
  );

  it.effect.each(["commit", "create_pr", "commit_push_pr"] as const)(
    "%s needs thread read permission only when generating a PR from a thread",
    (action) =>
      Effect.gen(function* () {
        const handled: string[] = [];
        const handler = group.toLayerHandler(WS_METHODS.gitRunStackedAction, ({ actionId }) =>
          Stream.fromEffect(Effect.sync(() => handled.push(actionId))).pipe(Stream.drain),
        );
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(handler, RpcAuthorization.layer([AuthSourceControlWriteScope])),
          ),
        );
        const input = { actionId: "without-thread", cwd: "/repo", action };
        const withThread = { ...input, actionId: "with-thread", threadId: ThreadId.make("thread") };
        yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](input));
        if (action === "create_pr" || action === "commit_push_pr") {
          expect(
            yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread)).pipe(
              Effect.flip,
            ),
          ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
          expect(handled).toEqual(["without-thread"]);
        } else {
          yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread));
          expect(handled).toEqual(["without-thread", "with-thread"]);
        }
        const reader = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              handler,
              RpcAuthorization.layer([AuthSourceControlWriteScope, AuthOrchestrationReadScope]),
            ),
          ),
        );
        yield* Stream.runDrain(
          reader[WS_METHODS.gitRunStackedAction]({ ...withThread, actionId: "allowed" }),
        );
        expect(handled.at(-1)).toBe("allowed");
      }),
  );
});

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "native-app-icon", app: { _tag: "app-id", appId: "com.apple.calculator" } },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "file.txt" },
      { _tag: "native-app-icon", app: { _tag: "app-path", path: "/private/Secret.app" } },
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(2);
  }),
);

it.effect("denies manual cleanup before the handler without settings permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverRunStorageCleanup
        > => tag !== WS_METHODS.serverRunStorageCleanup,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverRunStorageCleanup, () =>
            Effect.sync(() => {
              handled = true;
              return {
                trigger: "manual" as const,
                startedAt: "2026-10-09T12:00:00.000Z",
                finishedAt: "2026-10-09T12:00:00.000Z",
                entries: [],
                counts: { removed: 0, kept: 0, failed: 0 },
                omittedCount: 0,
                bytesFreed: 0,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.serverRunStorageCleanup]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(handled).toBe(false);
  }),
);
