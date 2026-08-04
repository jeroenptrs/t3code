import {
  CommandId,
  EventId,
  type OrchestrationCommand,
  type OrchestrationThread,
  OrchestrationDispatchCommandError,
  SCHEDULED_AUTOMATION_BOOTSTRAP_PHASE_REJECTED_CODE,
  ThreadId,
  type VcsRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import { OrchestrationEngineService } from "./OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./ProjectionSnapshotQuery.ts";
import {
  canonicalWorkspaceIdentity,
  WorkspaceMutationCoordinator,
} from "./WorkspaceMutationCoordinator.ts";

type BootstrapTurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function legacySetupFailureDescription(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

function projectSetupScriptCompatibilityDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return legacySetupFailureDescription(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
  }
}

export interface ThreadBootstrapServiceShape {
  readonly dispatch: (
    command: BootstrapTurnStartCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
}

export class ThreadBootstrapService extends Context.Service<
  ThreadBootstrapService,
  ThreadBootstrapServiceShape
>()("t3/orchestration/Services/ThreadBootstrapService") {}

export const makeThreadBootstrapService = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const commandReceipts = yield* OrchestrationCommandReceiptRepository;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const workspaceMutationCoordinator = yield* WorkspaceMutationCoordinator;

  const toDispatchError = (cause: unknown, fallbackMessage: string) =>
    isOrchestrationDispatchCommandError(cause)
      ? cause
      : new OrchestrationDispatchCommandError({
          message: cause instanceof Error ? cause.message : fallbackMessage,
          cause,
        });

  const randomUUID = crypto.randomUUIDv4.pipe(
    Effect.mapError((cause) =>
      toDispatchError(cause, "Failed to generate orchestration command identifier."),
    ),
  );
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  const phaseCommandId = (root: CommandId, phase: string) =>
    CommandId.make(`${root}:phase:${phase}`);

  const readThread = (threadId: ThreadId) =>
    projections
      .getThreadDetailById(threadId)
      .pipe(
        Effect.mapError((cause) =>
          toDispatchError(cause, "Failed to inspect bootstrap thread state."),
        ),
      );

  const readAcceptedReceipt = Effect.fn("ThreadBootstrapService.readAcceptedReceipt")(function* (
    commandId: CommandId,
    threadId: ThreadId,
  ) {
    const receipt = yield* commandReceipts
      .getByCommandId({ commandId })
      .pipe(
        Effect.mapError((cause) =>
          toDispatchError(cause, "Failed to inspect bootstrap command receipt."),
        ),
      );
    if (Option.isNone(receipt)) return Option.none();
    if (receipt.value.status !== "accepted") {
      return yield* new OrchestrationDispatchCommandError({
        code: SCHEDULED_AUTOMATION_BOOTSTRAP_PHASE_REJECTED_CODE,
        retryable: false,
        message: "The bootstrap phase command was durably rejected and cannot be retried.",
      });
    }
    if (receipt.value.aggregateKind !== "thread" || receipt.value.aggregateId !== threadId) {
      return yield* new OrchestrationDispatchCommandError({
        code: "bootstrap.receipt-provenance-conflict",
        retryable: false,
        message: "Bootstrap phase receipt provenance does not match the target thread.",
      });
    }
    return receipt;
  });

  const phaseConflict = (phase: string) =>
    new OrchestrationDispatchCommandError({
      code: "bootstrap.phase-state-conflict",
      retryable: false,
      message: `Bootstrap ${phase} projection and receipt truth do not agree.`,
    });

  const appendSetupScriptActivity = Effect.fn("ThreadBootstrapService.appendSetupScriptActivity")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
      readonly summary: string;
      readonly createdAt: string;
      readonly payload: Record<string, unknown>;
      readonly tone: "info" | "error";
    }) {
      const { commandId, activityId } = yield* Effect.all({
        commandId: serverCommandId("setup-script-activity"),
        activityId: serverEventId,
      });
      return yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId,
        threadId: input.threadId,
        activity: {
          id: activityId,
          tone: input.tone,
          kind: input.kind,
          summary: input.summary,
          payload: input.payload,
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
    },
  );

  const dispatch: ThreadBootstrapServiceShape["dispatch"] = Effect.fn(
    "ThreadBootstrapService.dispatch",
  )(function* (command) {
    const bootstrap = command.bootstrap;
    if (
      bootstrap?.prepareWorktree?.targetPath !== undefined &&
      bootstrap.prepareWorktree.branch === undefined
    ) {
      return yield* new OrchestrationDispatchCommandError({
        message: "A deterministic bootstrap worktree path requires a deterministic branch.",
      });
    }
    const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
    const targetProjectId = bootstrap?.createThread?.projectId;
    const targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
    let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;
    let currentPhase = "create-thread";
    let createdThreadThisDispatch = false;

    const reconcileThreadDefinition = Effect.fn("ThreadBootstrapService.reconcileThreadDefinition")(
      function* () {
        if (!bootstrap?.createThread || bootstrap.reconcileThreadRevision === undefined) return;
        const revision = bootstrap.reconcileThreadRevision;
        let thread = yield* readThread(command.threadId);
        if (Option.isNone(thread)) return yield* phaseConflict("definition-reconciliation");

        if (
          thread.value.title !== bootstrap.createThread.title ||
          !Equal.equals(thread.value.modelSelection, bootstrap.createThread.modelSelection)
        ) {
          const commandId = phaseCommandId(
            command.commandId,
            `reconcile-definition:${revision}:metadata`,
          );
          const receipt = yield* readAcceptedReceipt(commandId, command.threadId);
          if (Option.isSome(receipt)) return yield* phaseConflict("definition-metadata");
          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId,
            threadId: command.threadId,
            title: bootstrap.createThread.title,
            modelSelection: bootstrap.createThread.modelSelection,
          });
        }
        thread = yield* readThread(command.threadId);
        if (Option.isNone(thread)) return yield* phaseConflict("definition-reconciliation");
        if (thread.value.runtimeMode !== bootstrap.createThread.runtimeMode) {
          const commandId = phaseCommandId(
            command.commandId,
            `reconcile-definition:${revision}:runtime-mode`,
          );
          const receipt = yield* readAcceptedReceipt(commandId, command.threadId);
          if (Option.isSome(receipt)) return yield* phaseConflict("definition-runtime-mode");
          yield* orchestrationEngine.dispatch({
            type: "thread.runtime-mode.set",
            commandId,
            threadId: command.threadId,
            runtimeMode: bootstrap.createThread.runtimeMode,
            createdAt: command.createdAt,
          });
        }
        thread = yield* readThread(command.threadId);
        if (Option.isNone(thread)) return yield* phaseConflict("definition-reconciliation");
        if (thread.value.interactionMode !== bootstrap.createThread.interactionMode) {
          const commandId = phaseCommandId(
            command.commandId,
            `reconcile-definition:${revision}:interaction-mode`,
          );
          const receipt = yield* readAcceptedReceipt(commandId, command.threadId);
          if (Option.isSome(receipt)) return yield* phaseConflict("definition-interaction-mode");
          yield* orchestrationEngine.dispatch({
            type: "thread.interaction-mode.set",
            commandId,
            threadId: command.threadId,
            interactionMode: bootstrap.createThread.interactionMode,
            createdAt: command.createdAt,
          });
        }

        thread = yield* readThread(command.threadId);
        if (
          Option.isNone(thread) ||
          thread.value.projectId !== bootstrap.createThread.projectId ||
          thread.value.title !== bootstrap.createThread.title ||
          !Equal.equals(thread.value.modelSelection, bootstrap.createThread.modelSelection) ||
          thread.value.runtimeMode !== bootstrap.createThread.runtimeMode ||
          thread.value.interactionMode !== bootstrap.createThread.interactionMode
        ) {
          return yield* phaseConflict("definition-reconciliation");
        }
      },
    );

    const appendBootstrapFailure = Effect.fn("ThreadBootstrapService.appendBootstrapFailure")(
      function* () {
        const thread = yield* readThread(command.threadId);
        if (Option.isNone(thread)) return;
        const activityId = EventId.make(`${command.commandId}:activity:failed`);
        const failureCommandId = phaseCommandId(command.commandId, "record-failure");
        const receipt = yield* readAcceptedReceipt(failureCommandId, command.threadId);
        const activityExists = thread.value.activities.some(
          (activity) => activity.id === activityId,
        );
        if (Option.isSome(receipt) !== activityExists) {
          return yield* phaseConflict("failure-activity");
        }
        if (activityExists) return;
        const failedAt = yield* nowIso;
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: failureCommandId,
          threadId: command.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "bootstrap.failed",
            summary: "Thread bootstrap failed",
            payload: { phase: currentPhase },
            turnId: null,
            createdAt: failedAt,
          },
          createdAt: failedAt,
        });
      },
    );

    const runSetupProgram = Effect.fn("ThreadBootstrapService.runSetupProgram")(function* () {
      if (!bootstrap?.runSetupScript || !targetWorktreePath) return;
      const worktreePath = targetWorktreePath;
      const requestedAt = yield* nowIso;
      yield* projectSetupScriptRunner
        .runForThread({
          threadId: command.threadId,
          ...(targetProjectId ? { projectId: targetProjectId } : {}),
          ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
          worktreePath,
        })
        .pipe(
          Effect.matchEffect({
            onFailure: (error) => {
              const detail = projectSetupScriptCompatibilityDetail(error);
              return appendSetupScriptActivity({
                threadId: command.threadId,
                kind: "setup-script.failed",
                summary: "Setup script failed to start",
                createdAt: requestedAt,
                payload: { detail, worktreePath },
                tone: "error",
              }).pipe(
                Effect.ignoreCause({ log: false }),
                Effect.flatMap(() =>
                  Effect.logWarning("bootstrap turn start failed to launch setup script", {
                    threadId: command.threadId,
                    worktreePath,
                    detail,
                  }),
                ),
              );
            },
            onSuccess: (setupResult) => {
              if (setupResult.status !== "started") return Effect.void;
              return Effect.gen(function* () {
                const startedAt = yield* nowIso;
                const payload = {
                  scriptId: setupResult.scriptId,
                  scriptName: setupResult.scriptName,
                  terminalId: setupResult.terminalId,
                  worktreePath,
                };
                yield* Effect.all([
                  appendSetupScriptActivity({
                    threadId: command.threadId,
                    kind: "setup-script.requested",
                    summary: "Starting setup script",
                    createdAt: requestedAt,
                    payload,
                    tone: "info",
                  }),
                  appendSetupScriptActivity({
                    threadId: command.threadId,
                    kind: "setup-script.started",
                    summary: "Setup script started",
                    createdAt: startedAt,
                    payload,
                    tone: "info",
                  }),
                ]).pipe(
                  Effect.asVoid,
                  Effect.catch((error) =>
                    Effect.logWarning(
                      "bootstrap turn start launched setup script but failed to record setup activity",
                      {
                        threadId: command.threadId,
                        worktreePath,
                        scriptId: setupResult.scriptId,
                        terminalId: setupResult.terminalId,
                        detail: error.message,
                      },
                    ),
                  ),
                );
              });
            },
          }),
        );
    });

    const program = Effect.gen(function* () {
      let switchedRefName: string | null = null;
      if (bootstrap?.switchRef) {
        switchedRefName = (yield* gitWorkflow.switchRef(bootstrap.switchRef)).refName;
        yield* vcsStatusBroadcaster
          .refreshStatus(bootstrap.switchRef.cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
      }
      if (bootstrap?.createThread) {
        currentPhase = "create-thread";
        const createCommandId = phaseCommandId(command.commandId, "create-thread");
        const [thread, receipt] = yield* Effect.all([
          readThread(command.threadId),
          readAcceptedReceipt(createCommandId, command.threadId),
        ]);
        if (Option.isSome(thread) !== Option.isSome(receipt)) {
          return yield* phaseConflict("thread-create");
        }
        if (Option.isSome(thread) && thread.value.projectId !== bootstrap.createThread.projectId) {
          return yield* new OrchestrationDispatchCommandError({
            message: "The deterministic bootstrap thread belongs to a different project.",
          });
        }
        if (
          Option.isSome(thread) &&
          bootstrap.reconcileThreadRevision === undefined &&
          (thread.value.title !== bootstrap.createThread.title ||
            !Equal.equals(thread.value.modelSelection, bootstrap.createThread.modelSelection) ||
            thread.value.runtimeMode !== bootstrap.createThread.runtimeMode ||
            thread.value.interactionMode !== bootstrap.createThread.interactionMode)
        ) {
          return yield* new OrchestrationDispatchCommandError({
            message: "The bootstrap thread metadata does not match the create phase.",
          });
        }
        if (Option.isSome(thread) && bootstrap.prepareWorktree === undefined) {
          const expectedBranch = switchedRefName ?? bootstrap.createThread.branch;
          if (
            thread.value.branch !== expectedBranch ||
            thread.value.worktreePath !== bootstrap.createThread.worktreePath
          ) {
            return yield* new OrchestrationDispatchCommandError({
              message: "The bootstrap thread workspace does not match the create phase.",
            });
          }
        }
        if (Option.isNone(thread)) {
          yield* orchestrationEngine.dispatch({
            type: "thread.create",
            commandId: createCommandId,
            threadId: command.threadId,
            ...bootstrap.createThread,
            ...(switchedRefName ? { branch: switchedRefName } : {}),
          });
          createdThreadThisDispatch = true;
        }
        if (!createdThreadThisDispatch) yield* reconcileThreadDefinition();
      }

      if (bootstrap?.prepareWorktree) {
        currentPhase = "prepare-worktree";
        const threadBeforeWorktree = yield* readThread(command.threadId);
        if (Option.isNone(threadBeforeWorktree) && !createdThreadThisDispatch) {
          return yield* new OrchestrationDispatchCommandError({
            message: "The bootstrap thread is unavailable before worktree preparation.",
          });
        }
        if (
          bootstrap.prepareWorktree.targetPath !== undefined &&
          Option.isSome(threadBeforeWorktree) &&
          threadBeforeWorktree.value.worktreePath !== null &&
          canonicalWorkspaceIdentity(threadBeforeWorktree.value.worktreePath) !==
            canonicalWorkspaceIdentity(bootstrap.prepareWorktree.targetPath)
        ) {
          return yield* new OrchestrationDispatchCommandError({
            message: "The bootstrap thread metadata points at a different Git worktree.",
          });
        }
        const liveRefs: VcsRef[] = [];
        let cursor: number | undefined;
        do {
          const page = yield* gitWorkflow.listRefs({
            cwd: bootstrap.prepareWorktree.projectCwd,
            ...(cursor === undefined ? {} : { cursor }),
            includeMatchingRemoteRefs: false,
            refKind: "local",
            refresh: true,
            limit: 200,
          });
          liveRefs.push(...page.refs.filter((ref) => !ref.isRemote));
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);

        const deterministicPath = bootstrap.prepareWorktree.targetPath;
        const requestedBranch = bootstrap.prepareWorktree.branch;
        const existingRef =
          requestedBranch === undefined
            ? null
            : (liveRefs.find((ref) => ref.name === requestedBranch) ?? null);
        const lookupPathOwner = (worktreePath: string) =>
          liveRefs.find(
            (ref) =>
              ref.worktreePath !== null &&
              canonicalWorkspaceIdentity(ref.worktreePath) ===
                canonicalWorkspaceIdentity(worktreePath),
          ) ?? null;
        const pathOwner =
          deterministicPath === undefined ? null : lookupPathOwner(deterministicPath);

        if (
          existingRef?.worktreePath &&
          canonicalWorkspaceIdentity(existingRef.worktreePath) ===
            canonicalWorkspaceIdentity(bootstrap.prepareWorktree.projectCwd)
        ) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Temporary worktree branch '${existingRef.name}' is checked out in the project root. Switch the root checkout before retrying New worktree setup.`,
          });
        }

        let reusableWorktree: { readonly path: string; readonly refName: string } | null = null;
        let mayCreateWorktree = true;
        if (deterministicPath !== undefined) {
          const exactPair =
            existingRef?.worktreePath !== null &&
            existingRef?.worktreePath !== undefined &&
            canonicalWorkspaceIdentity(existingRef.worktreePath) ===
              canonicalWorkspaceIdentity(deterministicPath) &&
            pathOwner?.name === requestedBranch;
          const neitherExists = existingRef === null && pathOwner === null;
          if (exactPair) {
            reusableWorktree = { path: deterministicPath, refName: requestedBranch! };
            mayCreateWorktree = false;
          } else if (!neitherExists) {
            return yield* new OrchestrationDispatchCommandError({
              message:
                "The deterministic bootstrap branch and worktree path do not identify the same live Git worktree.",
            });
          }
        } else if (
          Option.isSome(threadBeforeWorktree) &&
          threadBeforeWorktree.value.worktreePath !== null
        ) {
          const recordedOwner = lookupPathOwner(threadBeforeWorktree.value.worktreePath);
          if (recordedOwner === null || recordedOwner.name !== threadBeforeWorktree.value.branch) {
            return yield* new OrchestrationDispatchCommandError({
              message: "The retained bootstrap thread no longer identifies a live Git worktree.",
            });
          }
          reusableWorktree = {
            path: threadBeforeWorktree.value.worktreePath,
            refName: recordedOwner.name,
          };
          mayCreateWorktree = false;
        } else if (existingRef?.worktreePath) {
          reusableWorktree = { path: existingRef.worktreePath, refName: existingRef.name };
          mayCreateWorktree = false;
        }

        let worktreeBaseRef = existingRef?.name ?? bootstrap.prepareWorktree.baseBranch;
        if (
          mayCreateWorktree &&
          existingRef === null &&
          bootstrap.prepareWorktree.startFromOrigin
        ) {
          yield* gitWorkflow.fetchRemote({
            cwd: bootstrap.prepareWorktree.projectCwd,
            remoteName: "origin",
          });
          const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
            cwd: bootstrap.prepareWorktree.projectCwd,
            refName: bootstrap.prepareWorktree.baseBranch,
            fallbackRemoteName: "origin",
          });
          worktreeBaseRef = resolvedRemoteBase.commitSha;
        }
        const worktree = reusableWorktree
          ? { worktree: reusableWorktree }
          : yield* gitWorkflow.createWorktree({
              cwd: bootstrap.prepareWorktree.projectCwd,
              refName: worktreeBaseRef,
              ...(existingRef ? {} : { newRefName: requestedBranch }),
              baseRefName: bootstrap.prepareWorktree.baseBranch,
              path: deterministicPath ?? null,
            });
        if (
          deterministicPath !== undefined &&
          (worktree.worktree.refName !== bootstrap.prepareWorktree.branch ||
            canonicalWorkspaceIdentity(worktree.worktree.path) !==
              canonicalWorkspaceIdentity(deterministicPath))
        ) {
          return yield* new OrchestrationDispatchCommandError({
            message:
              "Git returned a worktree that does not match the deterministic bootstrap branch and path.",
          });
        }
        targetWorktreePath = worktree.worktree.path;
        currentPhase = "update-thread-metadata";
        const metadataCommandId = phaseCommandId(command.commandId, "update-thread-metadata");
        const [thread, metadataReceipt] = yield* Effect.all([
          readThread(command.threadId),
          readAcceptedReceipt(metadataCommandId, command.threadId),
        ]);
        const metadataMatches =
          Option.isSome(thread) &&
          thread.value.worktreePath !== null &&
          canonicalWorkspaceIdentity(thread.value.worktreePath) ===
            canonicalWorkspaceIdentity(targetWorktreePath) &&
          thread.value.branch === worktree.worktree.refName;
        if (Option.isSome(metadataReceipt) && !metadataMatches) {
          return yield* phaseConflict("thread-metadata");
        }
        if (Option.isNone(metadataReceipt) && metadataMatches) {
          return yield* phaseConflict("thread-metadata");
        }
        if (Option.isNone(metadataReceipt)) {
          if (Option.isSome(thread) && thread.value.worktreePath !== null) {
            return yield* new OrchestrationDispatchCommandError({
              message: "The bootstrap thread metadata points at a different Git worktree.",
            });
          }
          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: metadataCommandId,
            threadId: command.threadId,
            branch: worktree.worktree.refName,
            worktreePath: targetWorktreePath,
          });
        }
        yield* vcsStatusBroadcaster
          .refreshStatus(targetWorktreePath)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
      }

      yield* runSetupProgram();
      currentPhase = "start-turn";
      const startCommandId = phaseCommandId(command.commandId, "start-turn");
      const [thread, startReceipt] = yield* Effect.all([
        readThread(command.threadId),
        readAcceptedReceipt(startCommandId, command.threadId),
      ]);
      let existingMessage: OrchestrationThread["messages"][number] | undefined;
      if (Option.isSome(thread)) {
        existingMessage = thread.value.messages.find(
          (message) => message.id === command.message.messageId,
        );
        if (existingMessage !== undefined) {
          if (
            existingMessage.role !== "user" ||
            existingMessage.text !== command.message.text ||
            !Equal.equals(existingMessage.attachments ?? [], command.message.attachments)
          ) {
            return yield* new OrchestrationDispatchCommandError({
              message: "The bootstrap message identifier belongs to different content.",
            });
          }
        }
      }
      if (Option.isSome(startReceipt) && existingMessage === undefined) {
        return yield* phaseConflict("turn-start");
      }
      if (Option.isNone(startReceipt) && existingMessage !== undefined) {
        return yield* phaseConflict("turn-start");
      }
      if (Option.isSome(startReceipt)) {
        return { sequence: startReceipt.value.resultSequence };
      }
      return yield* orchestrationEngine.dispatch({
        ...finalTurnStartCommand,
        commandId: startCommandId,
      });
    });

    const coordinatedProgram = bootstrap?.switchRef
      ? workspaceMutationCoordinator.withWorkspaceForProviderStartup(
          bootstrap.switchRef.cwd,
          command.threadId,
          program,
        )
      : bootstrap?.prepareWorktree
        ? workspaceMutationCoordinator.withWorkspace(bootstrap.prepareWorktree.projectCwd, program)
        : program;
    return yield* coordinatedProgram.pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        const dispatchError = isOrchestrationDispatchCommandError(error)
          ? error
          : new OrchestrationDispatchCommandError({
              message:
                error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
              cause,
            });
        if (Cause.hasInterruptsOnly(cause)) return Effect.fail(dispatchError);
        return appendBootstrapFailure().pipe(
          Effect.ignoreCause({ log: true }),
          Effect.flatMap(() => Effect.fail(dispatchError)),
        );
      }),
    );
  });

  return ThreadBootstrapService.of({ dispatch });
});

export const layer = Layer.effect(ThreadBootstrapService, makeThreadBootstrapService);
