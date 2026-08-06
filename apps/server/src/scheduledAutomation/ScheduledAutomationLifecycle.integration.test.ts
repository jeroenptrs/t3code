import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ScheduledAutomationDefinition,
  ScheduledAutomationId,
  type OrchestrationCommand,
  type ServerSettings,
  TurnId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../orchestration/Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  makeThreadBootstrapService,
  ThreadBootstrapService,
} from "../orchestration/Services/ThreadBootstrapService.ts";
import * as WorkspaceMutationCoordinator from "../orchestration/Services/WorkspaceMutationCoordinator.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadActivityRepositoryLive } from "../persistence/Layers/ProjectionThreadActivities.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProjectionThreadActivityRepository } from "../persistence/Services/ProjectionThreadActivities.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import {
  makeScheduledAutomationBootstrap,
  ScheduledAutomationBootstrap,
} from "./ScheduledAutomationBootstrap.ts";
import {
  deriveScheduledAutomationOccurrenceIdentity,
  isScheduledAutomationThreadActive,
} from "./ScheduledAutomationOccurrence.ts";
import {
  ScheduledAutomationRepository,
  ScheduledAutomationRepositoryLive,
} from "./ScheduledAutomationRepository.ts";
import { makeScheduledAutomationScheduler } from "./ScheduledAutomationScheduler.ts";
import { ScheduledAutomationValidation } from "./ScheduledAutomationValidation.ts";
import { makeScheduledAutomationWorktreePruner } from "./ScheduledAutomationWorktreePruner.ts";

const FIRST_DUE = "2026-08-04T10:01:00.000Z";
const SECOND_DUE = "2026-08-04T10:02:00.000Z";
const THIRD_DUE = "2026-08-04T10:04:00.000Z";
const RETENTION_NOW = "2026-08-20T10:04:00.000Z";

const decodeDefinition = Schema.decodeUnknownSync(ScheduledAutomationDefinition);
const definition = (projectId: ProjectId) =>
  decodeDefinition({
    name: "WP7 lifecycle qualification",
    prompt: "Inspect the integration repository without changing it.",
    projectId,
    modelSelection: { instanceId: ProviderInstanceId.make("fake-provider"), model: "fake-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePolicy: { kind: "new-worktree", baseBranch: "main", startFromOrigin: false },
    setupScriptPolicy: "skip",
    schedule: { cron: "* * * * *", timeZone: "UTC", misfirePolicy: "latest-only" },
  });

for (const restartPoint of [
  "thread.create",
  "worktree",
  "thread.meta.update",
  "thread.turn.start",
] as const) {
  it.effect(`qualifies the complete lifecycle after restart at ${restartPoint}`, () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "automation-lifecycle-" });
      const projectRoot = path.join(temp, "project");
      const worktreesDir = path.join(temp, "worktrees");
      const dbPath = path.join(temp, "state.sqlite");
      yield* fileSystem.makeDirectory(projectRoot, { recursive: true });

      const driver = yield* GitVcsDriver.GitVcsDriver;
      const git = (args: ReadonlyArray<string>) =>
        driver.execute({ operation: "automation-lifecycle.integration", cwd: projectRoot, args });
      yield* git(["init", "--initial-branch=main"]);
      yield* git(["config", "user.email", "test@example.com"]);
      yield* git(["config", "user.name", "Test User"]);
      yield* fileSystem.writeFileString(path.join(projectRoot, "README.md"), "qualification\n");
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "initial"]);

      const config = {
        worktreesDir,
        dbPath,
      } as ServerConfig["Service"];
      const projectId = ProjectId.make(`wp7-${restartPoint}`);
      const automationId = ScheduledAutomationId.make(`wp7-${restartPoint}`);
      const automationDefinition = definition(projectId);
      const firstIdentity = deriveScheduledAutomationOccurrenceIdentity(
        { automationId, scheduledFor: FIRST_DUE, worktreesDir },
        path,
      );
      expect(firstIdentity._tag).toBe("Success");
      if (firstIdentity._tag === "Failure") return;
      const acceptedTurnStartCommandIds: string[] = [];
      const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const unsupportedProviderCall = () => Effect.die("unsupported fake provider call") as never;
      const providerService = ProviderService.of({
        startSession: () => unsupportedProviderCall(),
        sendTurn: () => unsupportedProviderCall(),
        interruptTurn: () => unsupportedProviderCall(),
        respondToRequest: () => unsupportedProviderCall(),
        respondToUserInput: () => unsupportedProviderCall(),
        stopSession: () => unsupportedProviderCall(),
        listSessions: () => Effect.succeed([]),
        getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
        getInstanceInfo: (instanceId) => {
          const driverKind = ProviderDriverKind.make("fake-provider");
          return Effect.succeed({
            instanceId,
            driverKind,
            displayName: undefined,
            enabled: true,
            continuationIdentity: {
              driverKind,
              continuationKey: `fake-provider:instance:${instanceId}`,
            },
          });
        },
        rollbackConversation: () => unsupportedProviderCall(),
        get streamEvents() {
          return Stream.fromPubSub(runtimeEvents);
        },
      });
      let restartArmed = true;

      const makeRuntimeLayer = () => {
        const persistence = makeSqlitePersistenceLive(dbPath);
        const engineLayer = OrchestrationEngineLive.pipe(
          Layer.provide(OrchestrationProjectionSnapshotQueryLive),
          Layer.provide(OrchestrationProjectionPipelineLive),
          Layer.provide(OrchestrationEventStoreLive),
          Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        );
        return Layer.mergeAll(
          engineLayer,
          OrchestrationProjectionSnapshotQueryLive,
          OrchestrationCommandReceiptRepositoryLive,
          ProjectionThreadActivityRepositoryLive,
          ScheduledAutomationRepositoryLive,
        ).pipe(
          Layer.provideMerge(
            Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
              resolve: () => Effect.succeed(null),
            }),
          ),
          Layer.provideMerge(persistence),
          Layer.provideMerge(Layer.succeed(ServerConfig, config)),
        );
      };

      const makeRuntimeHarness = Effect.fn("ScheduledAutomationLifecycleTest.makeRuntimeHarness")(
        function* () {
          const engine = yield* OrchestrationEngineService;
          const projections = yield* ProjectionSnapshotQuery;
          const receipts = yield* OrchestrationCommandReceiptRepository;
          const projectionActivities = yield* ProjectionThreadActivityRepository;
          const repository = yield* ScheduledAutomationRepository;
          const sql = yield* SqlClient.SqlClient;

          const lifecycleProjections = projections;

          const interruptedEngine = OrchestrationEngineService.of({
            ...engine,
            dispatch: (command: OrchestrationCommand) =>
              engine.dispatch(command).pipe(
                Effect.tap(() =>
                  command.type === "thread.turn.start"
                    ? Effect.sync(() => acceptedTurnStartCommandIds.push(command.commandId))
                    : Effect.void,
                ),
                Effect.flatMap((result) => {
                  if (restartArmed && command.type === restartPoint) {
                    restartArmed = false;
                    return Effect.interrupt;
                  }
                  return Effect.succeed(result);
                }),
              ),
          });
          const gitWorkflow = GitWorkflowService.of({
            listRefs: driver.listRefs,
            createWorktree: (input: Parameters<typeof driver.createWorktree>[0]) =>
              driver.createWorktree(input).pipe(
                Effect.flatMap((result) => {
                  if (restartArmed && restartPoint === "worktree") {
                    restartArmed = false;
                    return Effect.interrupt;
                  }
                  return Effect.succeed(result);
                }),
              ),
            localStatus: driver.status,
            removeWorktree: driver.removeWorktree,
            invalidateLocalStatus: () => Effect.void,
            fetchRemote: () => Effect.die("origin fetch is excluded from this fixture"),
            resolveRemoteTrackingCommit: () =>
              Effect.die("origin resolution is excluded from this fixture"),
          } as unknown as GitWorkflowService["Service"]);

          const makeBootstrap = Effect.fn("ScheduledAutomationLifecycleTest.makeBootstrap")(
            function* () {
              const threadBootstrap = yield* makeThreadBootstrapService.pipe(
                Effect.provideService(OrchestrationEngineService, interruptedEngine),
                Effect.provideService(ProjectionSnapshotQuery, lifecycleProjections),
                Effect.provideService(OrchestrationCommandReceiptRepository, receipts),
                Effect.provideService(GitWorkflowService, gitWorkflow),
                Effect.provideService(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
                  runForThread: () => Effect.die("automation setup scripts must stay disabled"),
                } as unknown as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]),
                Effect.provideService(VcsStatusBroadcaster.VcsStatusBroadcaster, {
                  refreshStatus: () => Effect.succeed({}),
                } as unknown as VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]),
                Effect.provide(WorkspaceMutationCoordinator.layer),
              );
              return yield* makeScheduledAutomationBootstrap.pipe(
                Effect.provideService(ServerConfig, config),
                Effect.provideService(ProjectionSnapshotQuery, lifecycleProjections),
                Effect.provideService(ThreadBootstrapService, threadBootstrap),
              );
            },
          );
          const makeScheduler = Effect.fn("ScheduledAutomationLifecycleTest.makeScheduler")(
            function* () {
              const bootstrap = yield* makeBootstrap();
              return yield* makeScheduledAutomationScheduler().pipe(
                Effect.provideService(ScheduledAutomationRepository, repository),
                Effect.provideService(ProjectionSnapshotQuery, lifecycleProjections),
                Effect.provideService(OrchestrationCommandReceiptRepository, receipts),
                Effect.provideService(ScheduledAutomationBootstrap, bootstrap),
                Effect.provideService(ScheduledAutomationValidation, {
                  validateLiveDefinition: () => Effect.void,
                }),
                Effect.provideService(ServerConfig, config),
              );
            },
          );

          return {
            engine,
            projections,
            receipts,
            projectionActivities,
            repository,
            sql,
            lifecycleProjections,
            gitWorkflow,
            makeBootstrap,
            makeScheduler,
          } as const;
        },
      );

      yield* Effect.gen(function* () {
        const { engine, repository, makeBootstrap } = yield* makeRuntimeHarness();

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(`wp7:${restartPoint}:project-create`),
          projectId,
          title: "WP7 project",
          workspaceRoot: projectRoot,
          defaultModelSelection: null,
          createdAt: "2026-08-04T10:00:00.000Z",
        });
        const created = yield* repository.create({
          id: automationId,
          definition: automationDefinition,
          createdAt: "2026-08-04T10:00:00.000Z",
        });
        const enabled = yield* repository.compareAndSwapUpdate({
          automationId,
          expectedRevision: created.revision,
          replacement: {
            ...automationDefinition,
            enabled: true,
            enabledAt: "2026-08-04T10:00:00.000Z",
            lastScheduledFor: null,
            lastThreadId: null,
            lastOutcome: null,
            updatedAt: "2026-08-04T10:00:00.000Z",
          },
        });

        yield* TestClock.setTime(Date.parse(FIRST_DUE));
        const starting = yield* repository.claimOccurrence({
          automationId,
          expectedRevision: enabled.revision,
          scheduledFor: FIRST_DUE,
          lastThreadId: firstIdentity.success.threadId,
          lastOutcome: {
            kind: "starting",
            scheduledFor: FIRST_DUE,
            observedAt: FIRST_DUE,
            coalescedCount: 0,
          },
          updatedAt: FIRST_DUE,
        });
        const interruptedBootstrap = yield* makeBootstrap();
        yield* Effect.exit(interruptedBootstrap.dispatch(starting, FIRST_DUE));
        expect(restartArmed).toBe(false);
        expect(
          (yield* repository.get(automationId)).pipe(Option.getOrThrow).lastOutcome,
        ).toMatchObject({ kind: "starting", scheduledFor: FIRST_DUE });
      }).pipe(Effect.provide(makeRuntimeLayer()), Effect.scoped);

      yield* Effect.gen(function* () {
        const {
          engine,
          projections,
          receipts,
          projectionActivities,
          repository,
          sql,
          lifecycleProjections,
          gitWorkflow,
          makeScheduler,
        } = yield* makeRuntimeHarness();
        const afterRestart = yield* makeScheduler();
        yield* afterRestart.runOnce;
        const initial = Option.getOrThrow(yield* repository.get(automationId));
        expect(initial.lastOutcome).toMatchObject({ kind: "started" });
        expect(initial.lastScheduledFor).toBe(FIRST_DUE);
        const firstThreadId = initial.lastThreadId!;
        const firstThread = Option.getOrThrow(
          yield* projections.getThreadDetailById(firstThreadId),
        );
        const firstShell = Option.getOrThrow(yield* projections.getThreadShellById(firstThreadId));
        expect(firstThread.messages.map((message) => message.text)).toEqual([
          automationDefinition.prompt,
        ]);
        expect(firstThread.worktreePath).not.toBeNull();
        expect(yield* fileSystem.exists(firstThread.worktreePath!)).toBe(true);
        const initialRefs = yield* driver.listRefs({
          cwd: projectRoot,
          query: firstShell.branch!,
          refresh: true,
          limit: 100,
        });
        expect(
          initialRefs.refs.filter((ref) => ref.worktreePath === firstThread.worktreePath),
        ).toHaveLength(1);
        expect(acceptedTurnStartCommandIds).toEqual([
          firstIdentity.success.phaseCommandIds.startTurn,
        ]);
        expect(
          Option.isSome(
            yield* receipts.getByCommandId({
              commandId: firstIdentity.success.phaseCommandIds.startTurn,
            }),
          ),
        ).toBe(true);
        const rowCount = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM local_scheduled_automations_v1
        `;
        expect(rowCount[0]?.count).toBe(1);
        expect((yield* lifecycleProjections.getShellSnapshot()).threads).toHaveLength(1);

        const crypto = yield* Crypto.Crypto;
        const ingestionContext = yield* Layer.build(
          ProviderRuntimeIngestionLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(Crypto.Crypto, crypto),
                Layer.succeed(OrchestrationEngineService, engine),
                Layer.succeed(ProjectionSnapshotQuery, projections),
                Layer.succeed(ProviderService, providerService),
                Layer.succeed(SqlClient.SqlClient, sql),
                ServerSettingsService.layerTest(),
              ),
            ),
          ),
        );
        const ingestion = Context.get(ingestionContext, ProviderRuntimeIngestionService);
        yield* ingestion.start();
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`${firstThreadId}:command:fixture-session-ready`),
          threadId: firstThreadId,
          session: {
            threadId: firstThreadId,
            status: "ready",
            providerName: "fake-provider",
            runtimeMode: "full-access",
            activeTurnId: null,
            updatedAt: FIRST_DUE,
            lastError: null,
          },
          createdAt: FIRST_DUE,
        });
        const emitProviderEvent = Effect.fn("ScheduledAutomationLifecycleTest.emitProviderEvent")(
          function* (event: ProviderRuntimeEvent) {
            yield* PubSub.publish(runtimeEvents, event);
            yield* Effect.yieldNow;
            yield* ingestion.drain;
          },
        );
        const firstTurnId = TurnId.make(`${firstThreadId}:provider-turn`);
        yield* emitProviderEvent({
          type: "turn.started",
          eventId: EventId.make(`${firstThreadId}:event:turn-started`),
          provider: ProviderDriverKind.make("fake-provider"),
          providerInstanceId: ProviderInstanceId.make("fake-provider"),
          threadId: firstThreadId,
          createdAt: FIRST_DUE,
          turnId: firstTurnId,
          payload: {},
        });
        expect(
          Option.getOrThrow(yield* projections.getThreadShellById(firstThreadId)).latestTurn?.state,
        ).toBe("running");

        yield* TestClock.setTime(Date.parse(SECOND_DUE));
        yield* afterRestart.runOnce;
        const skipped = Option.getOrThrow(yield* repository.get(automationId));
        expect(skipped.lastOutcome).toMatchObject({
          kind: "skipped-active",
          scheduledFor: SECOND_DUE,
          previousThreadId: firstThreadId,
        });
        expect(acceptedTurnStartCommandIds).toHaveLength(1);
        expect((yield* lifecycleProjections.getShellSnapshot()).threads).toHaveLength(1);

        yield* emitProviderEvent({
          type: "turn.completed",
          eventId: EventId.make(`${firstThreadId}:event:turn-completed`),
          provider: ProviderDriverKind.make("fake-provider"),
          providerInstanceId: ProviderInstanceId.make("fake-provider"),
          threadId: firstThreadId,
          createdAt: SECOND_DUE,
          turnId: firstTurnId,
          payload: { state: "completed" },
        });
        yield* TestClock.setTime(Date.parse(THIRD_DUE));
        const terminalFirstShell = Option.getOrThrow(
          yield* lifecycleProjections.getThreadShellById(firstThreadId),
        );
        expect(isScheduledAutomationThreadActive(terminalFirstShell, { now: THIRD_DUE })).toBe(
          false,
        );
        expect(terminalFirstShell.session).toMatchObject({
          status: "ready",
          activeTurnId: null,
        });
        expect(terminalFirstShell.settledAt).toBeNull();
        yield* afterRestart.runOnce;
        const successor = Option.getOrThrow(yield* repository.get(automationId));
        expect(successor.lastOutcome?.kind).toBe("started");
        expect(successor.lastScheduledFor).toBe(THIRD_DUE);
        const secondThreadId = successor.lastThreadId!;
        expect(secondThreadId).not.toBe(firstThreadId);
        expect(acceptedTurnStartCommandIds).toHaveLength(2);
        expect(new Set(acceptedTurnStartCommandIds).size).toBe(2);
        expect((yield* lifecycleProjections.getShellSnapshot()).threads).toHaveLength(2);
        const secondTurnId = TurnId.make(`${secondThreadId}:provider-turn`);
        yield* emitProviderEvent({
          type: "turn.started",
          eventId: EventId.make(`${secondThreadId}:event:turn-started`),
          provider: ProviderDriverKind.make("fake-provider"),
          providerInstanceId: ProviderInstanceId.make("fake-provider"),
          threadId: secondThreadId,
          createdAt: THIRD_DUE,
          turnId: secondTurnId,
          payload: {},
        });
        yield* emitProviderEvent({
          type: "turn.completed",
          eventId: EventId.make(`${secondThreadId}:event:turn-completed`),
          provider: ProviderDriverKind.make("fake-provider"),
          providerInstanceId: ProviderInstanceId.make("fake-provider"),
          threadId: secondThreadId,
          createdAt: THIRD_DUE,
          turnId: secondTurnId,
          payload: { state: "completed" },
        });

        yield* TestClock.setTime(Date.parse(RETENTION_NOW));
        const pruner = yield* makeScheduledAutomationWorktreePruner().pipe(
          Effect.provideService(ServerConfig, config),
          Effect.provideService(ServerSettingsService, {
            getSettings: Effect.succeed({
              localScheduledAutomationWorktreeRetentionDays: 7,
            } as ServerSettings),
          } as unknown as ServerSettingsService["Service"]),
          Effect.provideService(ProjectionSnapshotQuery, lifecycleProjections),
          Effect.provideService(ProjectionThreadActivityRepository, projectionActivities),
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provideService(GitWorkflowService, gitWorkflow),
        );
        const pruneSummary = yield* pruner.runOnce;
        expect(pruneSummary).toEqual({ candidates: 2, pruned: 2, blocked: 0, deferred: 0 });
        expect(yield* fileSystem.exists(firstThread.worktreePath!)).toBe(false);
        const secondThread = Option.getOrThrow(
          yield* projections.getThreadDetailById(secondThreadId),
        );
        expect(yield* fileSystem.exists(secondThread.worktreePath!)).toBe(false);
        const retainedFirstThread = Option.getOrThrow(
          yield* projections.getThreadDetailById(firstThreadId),
        );
        const retainedSecondThread = Option.getOrThrow(
          yield* projections.getThreadDetailById(secondThreadId),
        );
        expect(
          retainedFirstThread.activities.some(
            (activity) => activity.kind === "local-scheduled-automation.worktree.pruned",
          ),
        ).toBe(true);
        expect(
          retainedSecondThread.activities.some(
            (activity) => activity.kind === "local-scheduled-automation.worktree.pruned",
          ),
        ).toBe(true);
        expect(firstShell.branch).not.toBeNull();
        expect(secondThread.branch).not.toBeNull();
        for (const branch of [firstShell.branch!, secondThread.branch!]) {
          const retainedRefs = yield* driver.listRefs({
            cwd: projectRoot,
            query: branch,
            refresh: true,
            limit: 100,
          });
          expect(retainedRefs.refs.find((ref) => ref.name === branch)).toMatchObject({
            worktreePath: null,
          });
        }
      }).pipe(Effect.provide(makeRuntimeLayer()), Effect.scoped);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          GitVcsDriver.layer.pipe(
            Layer.provideMerge(VcsProcess.layer),
            Layer.provideMerge(NodeServices.layer),
            Layer.provide(
              Layer.succeed(ServerConfig, {
                worktreesDir: "/tmp/unused-lifecycle-driver-default",
              } as ServerConfig["Service"]),
            ),
          ),
          NodeServices.layer,
        ),
      ),
      Effect.scoped,
    ),
  );
}
