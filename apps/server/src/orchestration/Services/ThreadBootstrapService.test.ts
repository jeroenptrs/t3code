import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../../config.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import { OrchestrationEngineLive } from "../Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./ProjectionSnapshotQuery.ts";
import { makeThreadBootstrapService } from "./ThreadBootstrapService.ts";
import * as WorkspaceMutationCoordinator from "./WorkspaceMutationCoordinator.ts";

type BootstrapCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

const command: BootstrapCommand = {
  type: "thread.turn.start",
  commandId: CommandId.make("start"),
  threadId: ThreadId.make("thread"),
  message: {
    messageId: MessageId.make("message"),
    role: "user",
    text: "Implement it",
    attachments: [],
  },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  titleSeed: "Implement it",
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-08-01T00:00:00.000Z",
  bootstrap: {
    createThread: {
      projectId: ProjectId.make("project"),
      title: "Implement it",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    prepareWorktree: {
      projectCwd: "/repo",
      baseBranch: "main",
      branch: "t3code/12345678",
    },
    runSetupScript: true,
  },
};

const deterministicCommand: BootstrapCommand = {
  ...command,
  commandId: CommandId.make("deterministic-bootstrap"),
  bootstrap: {
    ...command.bootstrap,
    prepareWorktree: {
      ...command.bootstrap!.prepareWorktree!,
      targetPath: "/automation-worktrees/occurrence",
      startFromOrigin: true,
    },
    runSetupScript: false,
  },
};

type StopPoint = "thread.create" | "worktree" | "thread.meta.update" | "thread.turn.start";

function makeResumptionHarness(
  stopPoint: StopPoint | null,
  options?: {
    readonly failureMode?: "interrupt" | "fail";
    readonly initialWorktree?: { readonly name: string; readonly path: string | null };
  },
) {
  let activeStopPoint = stopPoint;
  let thread: OrchestrationThread | null = null;
  let liveWorktree: { readonly name: string; readonly path: string | null } | null =
    options?.initialWorktree ?? null;
  let injected = false;
  let sequence = 0;
  const accepted = new Map<string, number>();
  const rejected = new Set<string>();
  const receiptAggregateOverrides = new Map<string, string>();
  const dispatchCounts = new Map<string, number>();
  let createWorktreeCount = 0;
  let fetchCount = 0;
  const listRefRefreshes: Array<boolean | undefined> = [];

  const dispatch = (next: OrchestrationCommand) =>
    Effect.suspend(() => {
      dispatchCounts.set(next.type, (dispatchCounts.get(next.type) ?? 0) + 1);
      const prior = accepted.get(next.commandId);
      if (prior !== undefined) return Effect.succeed({ sequence: prior });

      sequence += 1;
      accepted.set(next.commandId, sequence);
      if (next.type === "thread.create") {
        thread = {
          id: next.threadId,
          projectId: next.projectId,
          title: next.title,
          modelSelection: next.modelSelection,
          runtimeMode: next.runtimeMode,
          interactionMode: next.interactionMode,
          branch: next.branch,
          worktreePath: next.worktreePath,
          latestTurn: null,
          createdAt: next.createdAt,
          updatedAt: next.createdAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          titleRegeneration: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        };
      } else if (next.type === "thread.meta.update" && thread !== null) {
        thread = {
          ...thread,
          title: next.title ?? thread.title,
          modelSelection: next.modelSelection ?? thread.modelSelection,
          branch: next.branch ?? thread.branch,
          worktreePath: next.worktreePath ?? thread.worktreePath,
        };
      } else if (next.type === "thread.runtime-mode.set" && thread !== null) {
        thread = { ...thread, runtimeMode: next.runtimeMode };
      } else if (next.type === "thread.interaction-mode.set" && thread !== null) {
        thread = { ...thread, interactionMode: next.interactionMode };
      } else if (next.type === "thread.activity.append" && thread !== null) {
        thread = { ...thread, activities: [...thread.activities, next.activity] };
      } else if (next.type === "thread.turn.start" && thread !== null) {
        thread = {
          ...thread,
          messages: [
            ...thread.messages,
            {
              id: next.message.messageId,
              role: "user",
              text: next.message.text,
              attachments: next.message.attachments,
              turnId: null,
              streaming: false,
              createdAt: next.createdAt,
              updatedAt: next.createdAt,
            },
          ],
        };
      }
      if (!injected && activeStopPoint === next.type) {
        injected = true;
        return options?.failureMode === "fail"
          ? Effect.fail(
              new OrchestrationDispatchCommandError({
                message: "secret-token-must-not-be-recorded",
              }),
            )
          : Effect.interrupt;
      }
      return Effect.succeed({ sequence });
    });

  const makeService = makeThreadBootstrapService.pipe(
    Effect.provide(WorkspaceMutationCoordinator.layer),
    Effect.provideService(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
    Effect.provideService(OrchestrationEngineService, {
      dispatch,
      latestSequence: Effect.sync(() => sequence),
    } as unknown as OrchestrationEngineService["Service"]),
    Effect.provideService(ProjectionSnapshotQuery, {
      getThreadDetailById: () => Effect.sync(() => Option.fromNullishOr(thread)),
    } as unknown as ProjectionSnapshotQuery["Service"]),
    Effect.provideService(OrchestrationCommandReceiptRepository, {
      getByCommandId: ({ commandId }: { readonly commandId: CommandId }) => {
        const resultSequence = accepted.get(commandId);
        const isRejected = rejected.has(commandId);
        return Effect.succeed(
          resultSequence === undefined && !isRejected
            ? Option.none()
            : Option.some({
                commandId,
                aggregateKind: "thread" as const,
                aggregateId: ThreadId.make(
                  receiptAggregateOverrides.get(commandId) ?? deterministicCommand.threadId,
                ),
                acceptedAt: deterministicCommand.createdAt,
                resultSequence: resultSequence ?? 0,
                status: isRejected ? ("rejected" as const) : ("accepted" as const),
                error: isRejected ? "rejected" : null,
              }),
        );
      },
    } as unknown as OrchestrationCommandReceiptRepository["Service"]),
    Effect.provideService(GitWorkflowService.GitWorkflowService, {
      listRefs: (input: { readonly query?: string; readonly refresh?: boolean }) => {
        listRefRefreshes.push(input.refresh);
        return Effect.succeed({
          refs:
            liveWorktree !== null &&
            (input.query === undefined || input.query === liveWorktree.name)
              ? [
                  {
                    name: liveWorktree.name,
                    current: false,
                    isDefault: false,
                    worktreePath: liveWorktree.path,
                  },
                ]
              : [],
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: liveWorktree === null ? 0 : 1,
        });
      },
      createWorktree: (input: { readonly newRefName?: string; readonly path: string | null }) => {
        createWorktreeCount += 1;
        const createdWorktree = {
          name: input.newRefName ?? "main",
          path: input.path ?? "/generated-worktree",
        };
        liveWorktree = createdWorktree;
        if (!injected && activeStopPoint === "worktree") {
          injected = true;
          return options?.failureMode === "fail"
            ? Effect.fail(
                new OrchestrationDispatchCommandError({
                  message: "secret-token-must-not-be-recorded",
                }),
              )
            : Effect.interrupt;
        }
        return Effect.succeed({
          worktree: { refName: createdWorktree.name, path: createdWorktree.path },
        });
      },
      fetchRemote: () => {
        fetchCount += 1;
        return fetchCount > 1
          ? Effect.fail(
              new OrchestrationDispatchCommandError({ message: "origin is offline on retry" }),
            )
          : Effect.void;
      },
      resolveRemoteTrackingCommit: () =>
        Effect.succeed({ commitSha: "0123456789abcdef", remoteRefName: "origin/main" }),
    } as unknown as GitWorkflowService.GitWorkflowService["Service"]),
    Effect.provideService(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: () => Effect.die("setup scripts must be skipped"),
    } as unknown as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]),
    Effect.provideService(VcsStatusBroadcaster.VcsStatusBroadcaster, {
      refreshStatus: () => Effect.succeed({}),
    } as unknown as VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]),
  );

  return {
    makeService,
    state: () => ({
      thread,
      liveWorktree,
      accepted,
      dispatchCounts,
      createWorktreeCount,
      fetchCount,
      listRefRefreshes,
    }),
    pruneWorktree: () => {
      if (liveWorktree !== null) liveWorktree = { ...liveWorktree, path: null };
    },
    dropReceipt: (commandId: string) => accepted.delete(commandId),
    rejectReceipt: (commandId: string) => rejected.add(commandId),
    overrideReceiptAggregate: (commandId: string, threadId: string) =>
      receiptAggregateOverrides.set(commandId, threadId),
    mutateThread: (update: (current: OrchestrationThread) => OrchestrationThread) => {
      if (thread !== null) thread = update(thread);
    },
    removeThread: () => {
      thread = null;
    },
    failNext: (point: StopPoint) => {
      activeStopPoint = point;
      injected = false;
    },
  };
}

describe("ThreadBootstrapService", () => {
  for (const stopPoint of [
    "thread.create",
    "worktree",
    "thread.meta.update",
    "thread.turn.start",
  ] as const) {
    it.effect(`resumes without duplication after ${stopPoint}`, () =>
      Effect.gen(function* () {
        const harness = makeResumptionHarness(stopPoint);
        const service = yield* harness.makeService;

        yield* Effect.exit(service.dispatch(deterministicCommand));
        yield* service.dispatch(deterministicCommand);

        const state = harness.state();
        expect(state.thread).not.toBeNull();
        expect(state.liveWorktree).toEqual({
          name: "t3code/12345678",
          path: "/automation-worktrees/occurrence",
        });
        expect(state.createWorktreeCount).toBe(1);
        expect(state.fetchCount).toBe(1);
        expect(state.listRefRefreshes.every((refresh) => refresh === true)).toBe(true);
        expect(state.thread?.messages.map((message) => message.id)).toEqual(["message"]);
        expect(state.dispatchCounts.get("thread.create")).toBe(1);
        expect(state.dispatchCounts.get("thread.meta.update")).toBe(1);
        expect(state.dispatchCounts.get("thread.turn.start")).toBe(1);
        expect([...state.accepted.keys()]).toEqual([
          "deterministic-bootstrap:phase:create-thread",
          "deterministic-bootstrap:phase:update-thread-metadata",
          "deterministic-bootstrap:phase:start-turn",
        ]);
      }),
    );
  }

  it.effect("resumes across the real SQLite projection and receipt transaction boundary", () => {
    const orchestrationLayer = Layer.mergeAll(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationProjectionPipelineLive),
      ),
      OrchestrationProjectionSnapshotQueryLive,
    ).pipe(
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "thread-bootstrap-receipt-test-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    let liveWorktree: { readonly name: string; readonly path: string } | null = null;
    let createWorktreeCount = 0;
    let fetchCount = 0;
    let interruptAfterMetadata = true;

    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const receipts = yield* OrchestrationCommandReceiptRepository;
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("durable-project-create"),
        projectId: ProjectId.make("project"),
        title: "Project",
        workspaceRoot: "/repo",
        defaultModelSelection: null,
        createdAt: deterministicCommand.createdAt,
      });
      const bootstrapService = yield* makeThreadBootstrapService.pipe(
        Effect.provideService(OrchestrationEngineService, {
          ...engine,
          dispatch: (next: OrchestrationCommand) =>
            engine.dispatch(next).pipe(
              Effect.flatMap((result) => {
                if (next.type === "thread.meta.update" && interruptAfterMetadata) {
                  interruptAfterMetadata = false;
                  return Effect.interrupt;
                }
                return Effect.succeed(result);
              }),
            ),
        }),
      );

      yield* Effect.exit(bootstrapService.dispatch(deterministicCommand));
      const result = yield* bootstrapService.dispatch(deterministicCommand);
      const receipt = yield* receipts.getByCommandId({
        commandId: CommandId.make("deterministic-bootstrap:phase:start-turn"),
      });

      expect(result.sequence).toBeGreaterThan(0);
      expect(Option.getOrThrow(receipt)).toMatchObject({
        aggregateId: "thread",
        status: "accepted",
        resultSequence: result.sequence,
      });
      expect(createWorktreeCount).toBe(1);
      expect(fetchCount).toBe(1);
    }).pipe(
      Effect.provideService(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
      Effect.provideService(GitWorkflowService.GitWorkflowService, {
        listRefs: () =>
          Effect.succeed({
            refs:
              liveWorktree === null
                ? []
                : [
                    {
                      name: liveWorktree.name,
                      current: false,
                      isDefault: false,
                      worktreePath: liveWorktree.path,
                    },
                  ],
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: liveWorktree === null ? 0 : 1,
          }),
        fetchRemote: () => Effect.sync(() => void (fetchCount += 1)),
        resolveRemoteTrackingCommit: () => Effect.succeed({ commitSha: "abc123" }),
        createWorktree: (input: { readonly newRefName?: string; readonly path: string | null }) =>
          Effect.sync(() => {
            createWorktreeCount += 1;
            liveWorktree = { name: input.newRefName!, path: input.path! };
            return { worktree: { refName: liveWorktree.name, path: liveWorktree.path } };
          }),
      } as unknown as GitWorkflowService.GitWorkflowService["Service"]),
      Effect.provideService(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
        runForThread: () => Effect.die("scheduled bootstrap must skip setup"),
      } as unknown as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]),
      Effect.provideService(VcsStatusBroadcaster.VcsStatusBroadcaster, {
        refreshStatus: () => Effect.succeed({}),
      } as unknown as VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]),
      Effect.provide(Layer.mergeAll(orchestrationLayer, WorkspaceMutationCoordinator.layer)),
      Effect.scoped,
    );
  });

  it.effect("refuses branch-only deterministic state before fetch or worktree creation", () =>
    Effect.gen(function* () {
      const harness = makeResumptionHarness(null, {
        initialWorktree: { name: "t3code/12345678", path: null },
      });
      const service = yield* harness.makeService;

      const error = yield* service.dispatch(deterministicCommand).pipe(Effect.flip);

      expect(error.message).toContain("do not identify the same live Git worktree");
      expect(harness.state().fetchCount).toBe(0);
      expect(harness.state().createWorktreeCount).toBe(0);
    }),
  );

  it.effect("does not resurrect a deterministically pruned worktree", () =>
    Effect.gen(function* () {
      const harness = makeResumptionHarness(null);
      const service = yield* harness.makeService;
      yield* service.dispatch(deterministicCommand);
      harness.pruneWorktree();

      const error = yield* service.dispatch(deterministicCommand).pipe(Effect.flip);

      expect(error.message).toContain("do not identify the same live Git worktree");
      expect(harness.state().createWorktreeCount).toBe(1);
      expect(harness.state().fetchCount).toBe(1);
    }),
  );

  it.effect("reuses retained interactive worktree metadata before considering a new branch", () =>
    Effect.gen(function* () {
      const harness = makeResumptionHarness(null);
      const service = yield* harness.makeService;
      yield* service.dispatch(deterministicCommand);
      const interactiveRetry: BootstrapCommand = {
        ...deterministicCommand,
        bootstrap: {
          ...deterministicCommand.bootstrap,
          prepareWorktree: {
            projectCwd: "/repo",
            baseBranch: "main",
            branch: "t3code/a-new-client-retry-branch",
            startFromOrigin: true,
          },
        },
      };

      yield* service.dispatch(interactiveRetry);

      expect(harness.state().createWorktreeCount).toBe(1);
      expect(harness.state().fetchCount).toBe(1);
    }),
  );

  it.effect("fails a new-command interactive retry before leaking another worktree", () =>
    Effect.gen(function* () {
      const harness = makeResumptionHarness(null);
      const service = yield* harness.makeService;
      yield* service.dispatch(deterministicCommand);
      const retry: BootstrapCommand = {
        ...deterministicCommand,
        commandId: CommandId.make("interactive-retry-new-command"),
        message: {
          ...deterministicCommand.message,
          messageId: MessageId.make("interactive-retry-new-message"),
        },
        bootstrap: {
          ...deterministicCommand.bootstrap,
          prepareWorktree: {
            projectCwd: "/repo",
            baseBranch: "main",
            branch: "t3code/a-new-client-retry-branch",
            startFromOrigin: true,
          },
        },
      };

      const error = yield* service.dispatch(retry).pipe(Effect.flip);

      expect(error.message).toContain("thread-create projection and receipt truth do not agree");
      expect(harness.state().createWorktreeCount).toBe(1);
      expect(harness.state().fetchCount).toBe(1);
    }),
  );

  it.effect("rejects projected create state without its deterministic receipt", () =>
    Effect.gen(function* () {
      const harness = makeResumptionHarness(null);
      const service = yield* harness.makeService;
      yield* service.dispatch(deterministicCommand);
      harness.dropReceipt("deterministic-bootstrap:phase:create-thread");

      const error = yield* service.dispatch(deterministicCommand).pipe(Effect.flip);

      expect(error.message).toContain("thread-create projection and receipt truth do not agree");
      expect(harness.state().createWorktreeCount).toBe(1);
    }),
  );

  for (const phase of ["update-thread-metadata", "start-turn"] as const) {
    it.effect(`rejects projected ${phase} state without its deterministic receipt`, () =>
      Effect.gen(function* () {
        const harness = makeResumptionHarness(null);
        const service = yield* harness.makeService;
        yield* service.dispatch(deterministicCommand);
        harness.dropReceipt(`deterministic-bootstrap:phase:${phase}`);

        const error = yield* service.dispatch(deterministicCommand).pipe(Effect.flip);

        expect(error.message).toContain("projection and receipt truth do not agree");
        expect(harness.state().createWorktreeCount).toBe(1);
        expect(harness.state().dispatchCounts.get("thread.turn.start")).toBe(1);
      }),
    );
  }

  it.effect("rejects accepted create receipts without their projected thread", () =>
    Effect.gen(function* () {
      const harness = makeResumptionHarness(null);
      const service = yield* harness.makeService;
      yield* service.dispatch(deterministicCommand);
      harness.removeThread();

      const error = yield* service.dispatch(deterministicCommand).pipe(Effect.flip);

      expect(error).toMatchObject({
        code: "bootstrap.phase-state-conflict",
        retryable: false,
      });
      expect(error.message).toContain("thread-create projection and receipt truth do not agree");
    }),
  );

  it.effect("rejects accepted metadata receipts without projected metadata", () =>
    Effect.gen(function* () {
      const harness = makeResumptionHarness(null);
      const service = yield* harness.makeService;
      yield* service.dispatch(deterministicCommand);
      harness.mutateThread((thread) => ({ ...thread, branch: null, worktreePath: null }));

      const error = yield* service.dispatch(deterministicCommand).pipe(Effect.flip);

      expect(error.message).toContain("thread-metadata projection and receipt truth do not agree");
    }),
  );

  it.effect("rejects accepted start receipts without their projected message", () =>
    Effect.gen(function* () {
      const harness = makeResumptionHarness(null);
      const service = yield* harness.makeService;
      yield* service.dispatch(deterministicCommand);
      harness.mutateThread((thread) => ({ ...thread, messages: [] }));

      const error = yield* service.dispatch(deterministicCommand).pipe(Effect.flip);

      expect(error.message).toContain("turn-start projection and receipt truth do not agree");
    }),
  );

  it.effect("rejects rejected and wrong-aggregate deterministic receipts", () =>
    Effect.gen(function* () {
      const rejectedHarness = makeResumptionHarness(null);
      rejectedHarness.rejectReceipt("deterministic-bootstrap:phase:create-thread");
      const rejectedService = yield* rejectedHarness.makeService;
      const rejected = yield* rejectedService.dispatch(deterministicCommand).pipe(Effect.flip);
      expect(rejected).toMatchObject({
        code: "bootstrap.phase-rejected",
        retryable: false,
        message: "The bootstrap phase command was durably rejected and cannot be retried.",
      });

      const wrongHarness = makeResumptionHarness(null);
      const wrongService = yield* wrongHarness.makeService;
      yield* wrongService.dispatch(deterministicCommand);
      wrongHarness.overrideReceiptAggregate(
        "deterministic-bootstrap:phase:start-turn",
        "another-thread",
      );
      const wrong = yield* wrongService.dispatch(deterministicCommand).pipe(Effect.flip);
      expect(wrong.message).toContain("receipt provenance");
    }),
  );

  it.effect("rejects message collisions and same-project thread metadata conflicts", () =>
    Effect.gen(function* () {
      const messageHarness = makeResumptionHarness(null);
      const messageService = yield* messageHarness.makeService;
      yield* messageService.dispatch(deterministicCommand);
      messageHarness.mutateThread((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === deterministicCommand.message.messageId
            ? { ...message, text: "colliding content" }
            : message,
        ),
      }));
      const messageError = yield* messageService.dispatch(deterministicCommand).pipe(Effect.flip);
      expect(messageError.message).toContain("different content");

      const metadataHarness = makeResumptionHarness(null);
      const metadataService = yield* metadataHarness.makeService;
      yield* metadataService.dispatch(deterministicCommand);
      metadataHarness.mutateThread((thread) => ({ ...thread, title: "Wrong title" }));
      const metadataError = yield* metadataService.dispatch(deterministicCommand).pipe(Effect.flip);
      expect(metadataError.message).toContain("metadata does not match");
    }),
  );

  it.effect("uses receipt dedupe when concurrent dispatches pass the same initial reads", () =>
    Effect.gen(function* () {
      let thread: OrchestrationThread | null = null;
      let sequence = 0;
      let initialReadCount = 0;
      const initialReadsComplete = yield* Deferred.make<void>();
      let initialReceiptReadCount = 0;
      const initialReceiptReadsComplete = yield* Deferred.make<void>();
      const accepted = new Map<string, number>();
      const attempts = new Map<string, number>();
      const currentWorkspaceCommand: BootstrapCommand = {
        ...deterministicCommand,
        bootstrap: {
          createThread: deterministicCommand.bootstrap!.createThread!,
          runSetupScript: false,
        },
      };
      const service = yield* makeThreadBootstrapService.pipe(
        Effect.provide(WorkspaceMutationCoordinator.layer),
        Effect.provideService(
          Crypto.Crypto,
          Crypto.make({
            randomBytes: (size) => new Uint8Array(size),
            digest: (_algorithm, data) => Effect.succeed(data),
          }),
        ),
        Effect.provideService(ProjectionSnapshotQuery, {
          getThreadDetailById: () =>
            Effect.gen(function* () {
              const snapshot = thread;
              if (thread === null && initialReadCount < 2) {
                initialReadCount += 1;
                if (initialReadCount === 2)
                  yield* Deferred.succeed(initialReadsComplete, undefined);
                yield* Deferred.await(initialReadsComplete);
              }
              return Option.fromNullishOr(snapshot);
            }),
        } as unknown as ProjectionSnapshotQuery["Service"]),
        Effect.provideService(OrchestrationCommandReceiptRepository, {
          getByCommandId: ({ commandId }: { readonly commandId: CommandId }) =>
            Effect.gen(function* () {
              const resultSequence = accepted.get(commandId);
              if (
                commandId.endsWith(":phase:create-thread") &&
                resultSequence === undefined &&
                initialReceiptReadCount < 2
              ) {
                initialReceiptReadCount += 1;
                if (initialReceiptReadCount === 2) {
                  yield* Deferred.succeed(initialReceiptReadsComplete, undefined);
                }
                yield* Deferred.await(initialReceiptReadsComplete);
              }
              return resultSequence === undefined
                ? Option.none()
                : Option.some({
                    commandId,
                    aggregateKind: "thread" as const,
                    aggregateId: currentWorkspaceCommand.threadId,
                    acceptedAt: currentWorkspaceCommand.createdAt,
                    resultSequence,
                    status: "accepted" as const,
                    error: null,
                  });
            }),
        } as unknown as OrchestrationCommandReceiptRepository["Service"]),
        Effect.provideService(OrchestrationEngineService, {
          dispatch: (next: OrchestrationCommand) =>
            Effect.sync(() => {
              attempts.set(next.type, (attempts.get(next.type) ?? 0) + 1);
              const prior = accepted.get(next.commandId);
              if (prior !== undefined) return { sequence: prior };
              sequence += 1;
              accepted.set(next.commandId, sequence);
              if (next.type === "thread.create") {
                thread = {
                  id: next.threadId,
                  projectId: next.projectId,
                  title: next.title,
                  modelSelection: next.modelSelection,
                  runtimeMode: next.runtimeMode,
                  interactionMode: next.interactionMode,
                  branch: next.branch,
                  worktreePath: next.worktreePath,
                  latestTurn: null,
                  createdAt: next.createdAt,
                  updatedAt: next.createdAt,
                  archivedAt: null,
                  settledOverride: null,
                  settledAt: null,
                  snoozedUntil: null,
                  snoozedAt: null,
                  titleRegeneration: null,
                  deletedAt: null,
                  messages: [],
                  proposedPlans: [],
                  activities: [],
                  checkpoints: [],
                  session: null,
                };
              } else if (next.type === "thread.turn.start" && thread !== null) {
                thread = {
                  ...thread,
                  messages: [
                    ...thread.messages,
                    {
                      id: next.message.messageId,
                      role: "user",
                      text: next.message.text,
                      attachments: next.message.attachments,
                      turnId: null,
                      streaming: false,
                      createdAt: next.createdAt,
                      updatedAt: next.createdAt,
                    },
                  ],
                };
              }
              return { sequence };
            }),
        } as unknown as OrchestrationEngineService["Service"]),
        Effect.provideService(GitWorkflowService.GitWorkflowService, {
          listRefs: () => Effect.die("current-workspace bootstrap must not inspect Git"),
        } as unknown as GitWorkflowService.GitWorkflowService["Service"]),
        Effect.provideService(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
          runForThread: () => Effect.die("setup must stay disabled"),
        } as unknown as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]),
        Effect.provideService(VcsStatusBroadcaster.VcsStatusBroadcaster, {
          refreshStatus: () => Effect.die("current-workspace bootstrap must not refresh Git"),
        } as unknown as VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]),
      );

      yield* Effect.all(
        [service.dispatch(currentWorkspaceCommand), service.dispatch(currentWorkspaceCommand)],
        { concurrency: "unbounded" },
      );

      expect(initialReadCount).toBe(2);
      expect(attempts.get("thread.create")).toBe(2);
      expect([...accepted.keys()].filter((id) => id.endsWith(":phase:create-thread"))).toHaveLength(
        1,
      );
      expect((thread as OrchestrationThread | null)?.messages).toHaveLength(1);
    }),
  );

  it.effect(
    "retains partial state and records one deterministic secret-safe failure activity",
    () =>
      Effect.gen(function* () {
        const harness = makeResumptionHarness("thread.meta.update", { failureMode: "fail" });
        const service = yield* harness.makeService;

        yield* Effect.exit(service.dispatch(deterministicCommand));
        yield* service.dispatch(deterministicCommand);

        const state = harness.state();
        expect(state.thread?.worktreePath).toBe("/automation-worktrees/occurrence");
        expect(state.thread?.activities).toHaveLength(1);
        expect(state.thread?.activities[0]).toMatchObject({
          id: "deterministic-bootstrap:activity:failed",
          kind: "bootstrap.failed",
          payload: { phase: "update-thread-metadata" },
        });
        expect(state.thread?.activities[0]?.summary).not.toContain("secret-token");
        expect(state.thread?.activities[0]?.createdAt).not.toBe(deterministicCommand.createdAt);
        expect(state.dispatchCounts.get("thread.activity.append")).toBe(1);
        expect(state.dispatchCounts.has("thread.delete")).toBe(false);
      }),
  );

  it.effect("deduplicates the failure activity across consecutive phase failures", () =>
    Effect.gen(function* () {
      const harness = makeResumptionHarness("thread.meta.update", { failureMode: "fail" });
      const service = yield* harness.makeService;

      yield* Effect.exit(service.dispatch(deterministicCommand));
      harness.failNext("thread.turn.start");
      yield* Effect.exit(service.dispatch(deterministicCommand));
      yield* service.dispatch(deterministicCommand);

      expect(harness.state().thread?.activities).toHaveLength(1);
      expect(harness.state().dispatchCounts.get("thread.activity.append")).toBe(1);
      expect(harness.state().dispatchCounts.get("thread.turn.start")).toBe(1);
    }),
  );

  it.effect("reconciles supported definition fields on a corrected same-occurrence retry", () =>
    Effect.gen(function* () {
      const harness = makeResumptionHarness("thread.create", { failureMode: "fail" });
      const service = yield* harness.makeService;

      yield* Effect.exit(service.dispatch(deterministicCommand));
      const corrected: BootstrapCommand = {
        ...deterministicCommand,
        message: { ...deterministicCommand.message, text: "Corrected prompt" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
        titleSeed: "Corrected name",
        runtimeMode: "approval-required",
        interactionMode: "plan",
        bootstrap: {
          ...deterministicCommand.bootstrap,
          reconcileThreadRevision: 2,
          createThread: {
            ...deterministicCommand.bootstrap!.createThread!,
            title: "Corrected name",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.6",
            },
            runtimeMode: "approval-required",
            interactionMode: "plan",
          },
        },
      };

      yield* service.dispatch(corrected);

      expect(harness.state().thread).toMatchObject({
        title: "Corrected name",
        modelSelection: { model: "gpt-5.6" },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        branch: "t3code/12345678",
        worktreePath: "/automation-worktrees/occurrence",
        messages: [expect.objectContaining({ text: "Corrected prompt" })],
      });
      expect(harness.state().createWorktreeCount).toBe(1);
      expect(harness.state().dispatchCounts.get("thread.create")).toBe(1);
    }),
  );

  for (const initialWorktree of [
    { name: "t3code/12345678", path: "/someone-elses-worktree" },
    { name: "different-branch", path: "/automation-worktrees/occurrence" },
  ]) {
    it.effect("fails closed when deterministic branch and path do not agree", () =>
      Effect.gen(function* () {
        const harness = makeResumptionHarness(null, { initialWorktree });
        const service = yield* harness.makeService;

        const error = yield* service.dispatch(deterministicCommand).pipe(Effect.flip);

        expect(error.message).toContain("do not identify the same live Git worktree");
        expect(harness.state().createWorktreeCount).toBe(0);
        expect(harness.state().liveWorktree).toEqual(initialWorktree);
        expect(harness.state().dispatchCounts.has("thread.delete")).toBe(false);
      }),
    );
  }

  it.effect("preserves no-worktree bootstrap and applies the resolved switchRef branch", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const switched: Array<unknown> = [];
      const coordinator = yield* WorkspaceMutationCoordinator.make;
      const crypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) => Effect.succeed(data),
      });
      const service = yield* makeThreadBootstrapService.pipe(
        Effect.provideService(OrchestrationCommandReceiptRepository, {
          getByCommandId: () => Effect.succeed(Option.none()),
        } as unknown as OrchestrationCommandReceiptRepository["Service"]),
        Effect.provideService(ProjectionSnapshotQuery, {
          getThreadDetailById: () => Effect.succeed(Option.none()),
        } as unknown as ProjectionSnapshotQuery["Service"]),
        Effect.provideService(
          WorkspaceMutationCoordinator.WorkspaceMutationCoordinator,
          coordinator,
        ),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(OrchestrationEngineService, {
          dispatch: (next: OrchestrationCommand) => {
            dispatched.push(next);
            return (
              next.type === "thread.turn.start"
                ? coordinator.providerStartupSettled(next.threadId)
                : Effect.void
            ).pipe(Effect.as({ sequence: dispatched.length }));
          },
        } as unknown as OrchestrationEngineService["Service"]),
        Effect.provideService(GitWorkflowService.GitWorkflowService, {
          switchRef: (input: unknown) => {
            switched.push(input);
            return Effect.succeed({ refName: "resolved-feature" });
          },
        } as unknown as GitWorkflowService.GitWorkflowService["Service"]),
        Effect.provideService(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
          runForThread: () => Effect.die("not used"),
        } as unknown as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]),
        Effect.provideService(VcsStatusBroadcaster.VcsStatusBroadcaster, {
          refreshStatus: () => Effect.succeed({}),
        } as unknown as VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]),
      );
      const createThread = command.bootstrap!.createThread!;

      yield* service.dispatch({
        ...command,
        bootstrap: { createThread },
      });
      expect(dispatched.map((next) => next.type)).toEqual(["thread.create", "thread.turn.start"]);

      dispatched.length = 0;
      yield* service.dispatch({
        ...command,
        commandId: CommandId.make("start-switched"),
        threadId: ThreadId.make("thread-switched"),
        message: { ...command.message, messageId: MessageId.make("message-switched") },
        bootstrap: {
          switchRef: { cwd: "/repo", refName: "feature" },
          createThread,
        },
      });
      expect(switched).toEqual([{ cwd: "/repo", refName: "feature" }]);
      expect(dispatched[0]).toMatchObject({ type: "thread.create", branch: "resolved-feature" });
      expect(dispatched[1]).toMatchObject({ type: "thread.turn.start" });

      dispatched.length = 0;
      const targetPathError = yield* service
        .dispatch({
          ...command,
          bootstrap: {
            ...command.bootstrap,
            prepareWorktree: {
              projectCwd: "/repo",
              baseBranch: "main",
              targetPath: "/tmp/worktrees/deterministic",
            },
          },
        })
        .pipe(Effect.flip);
      expect(targetPathError).toMatchObject({
        _tag: "OrchestrationDispatchCommandError",
        message: "A deterministic bootstrap worktree path requires a deterministic branch.",
      });
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("preserves create, worktree, setup activity, metadata, and final-start ordering", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const worktrees: Array<unknown> = [];
      const setupRuns: Array<unknown> = [];
      const refreshes: Array<string> = [];
      let reusableWorktreePath: string | null = null;
      const listRefCursors: Array<number | undefined> = [];
      const listRefQueries: Array<string | undefined> = [];
      let uuid = 0;
      const crypto = {
        ...Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
        randomUUIDv4: Effect.sync(
          () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
        ),
      };
      const service = yield* makeThreadBootstrapService.pipe(
        Effect.provideService(OrchestrationCommandReceiptRepository, {
          getByCommandId: () => Effect.succeed(Option.none()),
        } as unknown as OrchestrationCommandReceiptRepository["Service"]),
        Effect.provideService(ProjectionSnapshotQuery, {
          getThreadDetailById: () => Effect.succeed(Option.none()),
        } as unknown as ProjectionSnapshotQuery["Service"]),
        Effect.provide(WorkspaceMutationCoordinator.layer),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(OrchestrationEngineService, {
          dispatch: (next: OrchestrationCommand) => {
            dispatched.push(next);
            return Effect.succeed({ sequence: dispatched.length });
          },
        } as unknown as OrchestrationEngineService["Service"]),
        Effect.provideService(GitWorkflowService.GitWorkflowService, {
          listRefs: (input: { readonly cursor?: number; readonly query?: string }) => {
            listRefCursors.push(input.cursor);
            listRefQueries.push(input.query);
            return Effect.succeed({
              refs:
                reusableWorktreePath && input.cursor === 200
                  ? [
                      {
                        name: "t3code/12345678",
                        current: false,
                        isDefault: false,
                        worktreePath: reusableWorktreePath,
                      },
                    ]
                  : [],
              isRepo: true,
              hasPrimaryRemote: true,
              nextCursor: reusableWorktreePath && input.cursor === undefined ? 200 : null,
              totalCount: reusableWorktreePath ? 201 : 0,
            });
          },
          createWorktree: (input: unknown) => {
            worktrees.push(input);
            return Effect.succeed({
              worktree: { path: "/repo/.t3/worktrees/12345678", refName: "t3code/12345678" },
            });
          },
        } as unknown as GitWorkflowService.GitWorkflowService["Service"]),
        Effect.provideService(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
          runForThread: (input: unknown) => {
            setupRuns.push(input);
            return Effect.succeed({
              status: "started",
              scriptId: "setup",
              scriptName: "Setup",
              terminalId: "setup-terminal",
              cwd: "/repo/.t3/worktrees/12345678",
            });
          },
        } as unknown as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]),
        Effect.provideService(VcsStatusBroadcaster.VcsStatusBroadcaster, {
          refreshStatus: (cwd: string) => {
            refreshes.push(cwd);
            return Effect.succeed({});
          },
        } as unknown as VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]),
      );

      yield* service.dispatch(command);
      yield* Effect.yieldNow;

      expect(worktrees).toEqual([
        {
          cwd: "/repo",
          refName: "main",
          newRefName: "t3code/12345678",
          baseRefName: "main",
          path: null,
        },
      ]);
      expect(setupRuns).toEqual([
        {
          threadId: "thread",
          projectId: "project",
          projectCwd: "/repo",
          worktreePath: "/repo/.t3/worktrees/12345678",
        },
      ]);
      expect(refreshes).toEqual(["/repo/.t3/worktrees/12345678"]);
      expect(dispatched.map((next) => next.type)).toEqual([
        "thread.create",
        "thread.meta.update",
        "thread.activity.append",
        "thread.activity.append",
        "thread.turn.start",
      ]);
      expect(dispatched.at(-1)).not.toHaveProperty("bootstrap");

      reusableWorktreePath = "/repo/.t3/worktrees/12345678";
      yield* service.dispatch({
        ...command,
        commandId: CommandId.make("start-retry"),
        threadId: ThreadId.make("thread-retry"),
        message: { ...command.message, messageId: MessageId.make("message-retry") },
      });
      expect(worktrees).toHaveLength(1);
      expect(listRefCursors).toEqual([undefined, undefined, 200]);
      expect(listRefQueries).toEqual([undefined, undefined, undefined]);
      expect(dispatched).toContainEqual(
        expect.objectContaining({
          type: "thread.meta.update",
          threadId: "thread-retry",
          worktreePath: reusableWorktreePath,
        }),
      );

      reusableWorktreePath = "/repo/./";
      const conflict = yield* service
        .dispatch({
          ...command,
          commandId: CommandId.make("start-root-conflict"),
          threadId: ThreadId.make("thread-root-conflict"),
          message: { ...command.message, messageId: MessageId.make("message-root-conflict") },
        })
        .pipe(Effect.flip);
      expect(conflict.message).toContain("checked out in the project root");
      expect(worktrees).toHaveLength(1);
      expect(dispatched.at(-1)?.type).toBe("thread.create");
      expect(dispatched.some((next) => next.type === "thread.delete")).toBe(false);
    }),
  );
});
