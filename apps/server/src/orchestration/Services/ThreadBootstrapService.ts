import {
  CommandId,
  EventId,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  ThreadId,
  type VcsRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import { OrchestrationEngineService } from "./OrchestrationEngine.ts";
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
    if (bootstrap?.prepareWorktree?.targetPath !== undefined) {
      return yield* new OrchestrationDispatchCommandError({
        message:
          "Explicit bootstrap worktree paths are not supported until deterministic bootstrap validation is enabled.",
      });
    }
    const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
    let createdThread = false;
    const targetProjectId = bootstrap?.createThread?.projectId;
    const targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
    let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

    const cleanupCreatedThread = () =>
      createdThread
        ? serverCommandId("bootstrap-thread-delete").pipe(
            Effect.flatMap((commandId) =>
              orchestrationEngine.dispatch({
                type: "thread.delete",
                commandId,
                threadId: command.threadId,
              }),
            ),
            Effect.ignoreCause({ log: true }),
          )
        : Effect.void;

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
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: yield* serverCommandId("bootstrap-thread-create"),
          threadId: command.threadId,
          ...bootstrap.createThread,
          ...(switchedRefName ? { branch: switchedRefName } : {}),
        });
        createdThread = true;
      }

      if (bootstrap?.prepareWorktree) {
        let worktreeBaseRef = bootstrap.prepareWorktree.baseBranch;
        if (bootstrap.prepareWorktree.startFromOrigin) {
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
        let existingRef: VcsRef | null = null;
        if (bootstrap.prepareWorktree.branch) {
          let cursor: number | undefined;
          let nextCursor: number | null = null;
          do {
            const page = yield* gitWorkflow.listRefs({
              cwd: bootstrap.prepareWorktree.projectCwd,
              ...(cursor === undefined ? {} : { cursor }),
              query: bootstrap.prepareWorktree.branch,
              includeMatchingRemoteRefs: false,
              limit: 200,
            });
            existingRef ??=
              page.refs.find(
                (ref) => !ref.isRemote && ref.name === bootstrap.prepareWorktree?.branch,
              ) ?? null;
            nextCursor = existingRef ? null : page.nextCursor;
            cursor = nextCursor ?? undefined;
          } while (nextCursor !== null);
        }
        if (
          existingRef?.worktreePath &&
          canonicalWorkspaceIdentity(existingRef.worktreePath) ===
            canonicalWorkspaceIdentity(bootstrap.prepareWorktree.projectCwd)
        ) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Temporary worktree branch '${existingRef.name}' is checked out in the project root. Switch the root checkout before retrying New worktree setup.`,
          });
        }
        const worktree = existingRef?.worktreePath
          ? { worktree: { path: existingRef.worktreePath, refName: existingRef.name } }
          : yield* gitWorkflow.createWorktree({
              cwd: bootstrap.prepareWorktree.projectCwd,
              refName: existingRef?.name ?? worktreeBaseRef,
              ...(existingRef ? {} : { newRefName: bootstrap.prepareWorktree.branch }),
              baseRefName: bootstrap.prepareWorktree.baseBranch,
              path: null,
            });
        targetWorktreePath = worktree.worktree.path;
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
          threadId: command.threadId,
          branch: worktree.worktree.refName,
          worktreePath: targetWorktreePath,
        });
        yield* vcsStatusBroadcaster
          .refreshStatus(targetWorktreePath)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
      }

      yield* runSetupProgram();
      return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
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
        return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
      }),
    );
  });

  return ThreadBootstrapService.of({ dispatch });
});

export const layer = Layer.effect(ThreadBootstrapService, makeThreadBootstrapService);
