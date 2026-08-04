import { OrchestrationDispatchCommandError, type ScheduledAutomation } from "@t3tools/contracts";
import { canonicalPathIdentity } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBootstrapService } from "../orchestration/Services/ThreadBootstrapService.ts";
import {
  deriveScheduledAutomationOccurrenceIdentity,
  SCHEDULED_AUTOMATION_WORKTREE_SUBTREE,
} from "./ScheduledAutomationOccurrence.ts";

export interface ScheduledAutomationBootstrapShape {
  readonly dispatch: (
    automation: ScheduledAutomation,
    scheduledFor: string,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
}

export class ScheduledAutomationBootstrap extends Context.Service<
  ScheduledAutomationBootstrap,
  ScheduledAutomationBootstrapShape
>()("t3/scheduledAutomation/ScheduledAutomationBootstrap") {}

export const makeScheduledAutomationBootstrap = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const path = yield* Path.Path;
  const projections = yield* ProjectionSnapshotQuery;
  const threadBootstrap = yield* ThreadBootstrapService;

  const dispatch: ScheduledAutomationBootstrapShape["dispatch"] = Effect.fn(
    "ScheduledAutomationBootstrap.dispatch",
  )(function* (automation, scheduledFor) {
    const project = yield* projections.getProjectShellById(automation.projectId).pipe(
      Effect.mapError(
        () =>
          new OrchestrationDispatchCommandError({
            code: "automation.project-query-failed",
            retryable: true,
            message: "Failed to load the scheduled automation project.",
          }),
      ),
    );
    if (Option.isNone(project)) {
      return yield* new OrchestrationDispatchCommandError({
        code: "automation.project-unavailable",
        retryable: true,
        message: "The scheduled automation project is unavailable.",
      });
    }

    const identity = deriveScheduledAutomationOccurrenceIdentity(
      {
        automationId: automation.id,
        scheduledFor,
        worktreesDir: config.worktreesDir,
      },
      path,
    );
    if (Result.isFailure(identity)) {
      return yield* new OrchestrationDispatchCommandError({
        code: "automation.identity-invalid",
        retryable: false,
        message: identity.failure.message,
      });
    }

    const occurrence = identity.success;
    const automationRoot = canonicalPathIdentity(
      path.resolve(config.worktreesDir, SCHEDULED_AUTOMATION_WORKTREE_SUBTREE),
    );
    const occurrenceWorktreePath = canonicalPathIdentity(occurrence.worktreePath);
    if (!occurrenceWorktreePath.startsWith(`${automationRoot}/`)) {
      return yield* new OrchestrationDispatchCommandError({
        code: "automation.worktree-path-escape",
        retryable: false,
        message: "The scheduled automation worktree path escaped its owned root.",
      });
    }
    return yield* threadBootstrap
      .dispatch({
        type: "thread.turn.start",
        commandId: occurrence.bootstrapCommandId,
        threadId: occurrence.threadId,
        message: {
          messageId: occurrence.messageId,
          role: "user",
          text: automation.prompt,
          attachments: [],
        },
        modelSelection: automation.modelSelection,
        titleSeed: automation.name,
        runtimeMode: automation.runtimeMode,
        interactionMode: automation.interactionMode,
        bootstrap: {
          createThread: {
            projectId: automation.projectId,
            title: automation.name,
            modelSelection: automation.modelSelection,
            runtimeMode: automation.runtimeMode,
            interactionMode: automation.interactionMode,
            branch: null,
            worktreePath: null,
            createdAt: scheduledFor,
          },
          ...(automation.worktreePolicy.kind === "new-worktree"
            ? {
                prepareWorktree: {
                  projectCwd: project.value.workspaceRoot,
                  baseBranch: automation.worktreePolicy.baseBranch,
                  branch: occurrence.branch,
                  targetPath: occurrence.worktreePath,
                  ...(automation.worktreePolicy.startFromOrigin ? { startFromOrigin: true } : {}),
                },
              }
            : {}),
          runSetupScript: false,
          reconcileThreadRevision: automation.revision,
        },
        createdAt: scheduledFor,
      })
      .pipe(
        Effect.mapError((error) =>
          error.retryable !== undefined
            ? error
            : new OrchestrationDispatchCommandError({
                code: error.code ?? "bootstrap.retryable",
                retryable: true,
                message: error.message,
                ...(error.cause === undefined ? {} : { cause: error.cause }),
              }),
        ),
      );
  });

  return ScheduledAutomationBootstrap.of({ dispatch });
});

export const layer = Layer.effect(ScheduledAutomationBootstrap, makeScheduledAutomationBootstrap);
