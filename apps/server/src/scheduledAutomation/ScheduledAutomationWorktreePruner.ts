import type {
  OrchestrationProjectShell,
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import { CommandId, EventId } from "@t3tools/contracts";
import { canonicalPathIdentity } from "@t3tools/shared/path";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import { ServerConfig } from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProjectionThreadActivityRepository,
  type ProjectionThreadActivity,
} from "../persistence/Services/ProjectionThreadActivities.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  isScheduledAutomationThreadActive,
  parseScheduledAutomationThreadIdentity,
  SCHEDULED_AUTOMATION_WORKTREE_SUBTREE,
} from "./ScheduledAutomationOccurrence.ts";

export const SCHEDULED_AUTOMATION_WORKTREE_HOUSEKEEPING_INTERVAL = Duration.hours(6);
const DAY_MILLIS = 24 * 60 * 60 * 1_000;

export type ScheduledAutomationPruneBlockedReason =
  | "branch-mismatch"
  | "worktree-path-missing"
  | "worktree-path-mismatch"
  | "worktree-path-outside-root"
  | "worktree-path-canonicalization-failed"
  | "git-list-failed"
  | "git-list-mismatch"
  | "git-status-failed"
  | "dirty-worktree"
  | "projection-refresh-failed"
  | "project-missing"
  | "ownership-changed"
  | "remove-failed"
  | "remove-verification-failed";

export interface ScheduledAutomationWorktreePruneSummary {
  readonly candidates: number;
  readonly pruned: number;
  readonly blocked: number;
  readonly deferred: number;
}

export interface ScheduledAutomationWorktreePrunerShape {
  readonly runOnce: Effect.Effect<ScheduledAutomationWorktreePruneSummary>;
  readonly run: Effect.Effect<never>;
}

export interface ScheduledAutomationWorktreePrunerOptions {
  readonly onRunComplete?: (
    summary: ScheduledAutomationWorktreePruneSummary,
  ) => Effect.Effect<void>;
}

export class ScheduledAutomationWorktreePruner extends Context.Service<
  ScheduledAutomationWorktreePruner,
  ScheduledAutomationWorktreePrunerShape
>()("t3/scheduledAutomation/ScheduledAutomationWorktreePruner") {}

function latestMeaningfulActivityAt(
  thread: OrchestrationThreadShell,
  activities: ReadonlyArray<ProjectionThreadActivity>,
): number {
  const housekeepingActivityTimes = new Set(
    activities
      .filter((activity) => activity.kind.startsWith("local-scheduled-automation.worktree.prune"))
      .map((activity) => activity.createdAt),
  );
  const timestamps = [
    thread.createdAt,
    thread.archivedAt,
    thread.settledAt,
    thread.latestUserMessageAt,
    ...(housekeepingActivityTimes.has(thread.updatedAt) ? [] : [thread.updatedAt]),
  ];
  if (thread.latestTurn !== null) {
    timestamps.push(
      thread.latestTurn.requestedAt,
      thread.latestTurn.startedAt,
      thread.latestTurn.completedAt,
    );
  }
  for (const activity of activities) {
    if (!activity.kind.startsWith("local-scheduled-automation.worktree.prune")) {
      timestamps.push(activity.createdAt);
    }
  }
  return Math.max(...timestamps.flatMap((value) => (value === null ? [] : [Date.parse(value)])));
}

function hasPrunedActivity(activities: ReadonlyArray<ProjectionThreadActivity>): boolean {
  return activities.some(
    (activity) => activity.kind === "local-scheduled-automation.worktree.pruned",
  );
}

function activityIdentity(
  threadId: string,
  outcome: "pruned" | ScheduledAutomationPruneBlockedReason,
) {
  const suffix = `worktree-prune:${outcome}`;
  return {
    commandId: CommandId.make(`${threadId}:command:${suffix}`),
    activityId: EventId.make(`${threadId}:activity:${suffix}`),
  };
}

export const makeScheduledAutomationWorktreePruner = Effect.fn(
  "ScheduledAutomationWorktreePruner.make",
)(function* (options: ScheduledAutomationWorktreePrunerOptions = {}) {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettingsService;
  const projections = yield* ProjectionSnapshotQuery;
  const projectionActivities = yield* ProjectionThreadActivityRepository;
  const orchestration = yield* OrchestrationEngineService;
  const git = yield* GitWorkflowService;

  const appendActivity = Effect.fn("ScheduledAutomationWorktreePruner.appendActivity")(function* (
    thread: OrchestrationThreadShell,
    input:
      | { readonly kind: "pruned" }
      | { readonly kind: "blocked"; readonly reason: ScheduledAutomationPruneBlockedReason },
    createdAt: string,
  ) {
    const identity = activityIdentity(thread.id, input.kind === "pruned" ? "pruned" : input.reason);
    const activity: OrchestrationThreadActivity =
      input.kind === "pruned"
        ? {
            id: identity.activityId,
            tone: "info",
            kind: "local-scheduled-automation.worktree.pruned",
            summary:
              "This automation worktree was pruned. Create a new thread/worktree from the retained branch to continue.",
            payload: { branchRetained: true, resumableInPlace: false },
            turnId: null,
            createdAt,
          }
        : {
            id: identity.activityId,
            tone: "error",
            kind: "local-scheduled-automation.worktree.prune-blocked",
            summary: `Automation worktree pruning was blocked: ${input.reason}.`,
            payload: { reason: input.reason },
            turnId: null,
            createdAt,
          };
    yield* orchestration.dispatch({
      type: "thread.activity.append",
      commandId: identity.commandId,
      threadId: thread.id,
      activity,
      createdAt,
    });
  });

  const block = Effect.fn("ScheduledAutomationWorktreePruner.block")(function* (
    thread: OrchestrationThreadShell,
    reason: ScheduledAutomationPruneBlockedReason,
    createdAt: string,
  ) {
    const appended = yield* Effect.result(
      appendActivity(thread, { kind: "blocked", reason }, createdAt),
    );
    if (Result.isFailure(appended)) {
      yield* Effect.logWarning("Failed to append automation worktree prune-blocked activity", {
        threadId: thread.id,
        reason,
        error: String(appended.failure),
      });
      return "deferred" as const;
    }
    return "blocked" as const;
  });

  const markPruned = Effect.fn("ScheduledAutomationWorktreePruner.markPruned")(function* (
    thread: OrchestrationThreadShell,
    createdAt: string,
  ) {
    const appended = yield* Effect.result(appendActivity(thread, { kind: "pruned" }, createdAt));
    if (Result.isFailure(appended)) {
      yield* Effect.logWarning("Failed to append automation worktree pruned activity", {
        threadId: thread.id,
        error: String(appended.failure),
      });
      return "deferred" as const;
    }
    return "pruned" as const;
  });

  const canonicalize = (value: string) =>
    Effect.result(fileSystem.realPath(path.resolve(value))).pipe(
      Effect.map((result) => (Result.isSuccess(result) ? result.success : null)),
    );

  const findRegisteredRef = Effect.fn("ScheduledAutomationWorktreePruner.findRegisteredRef")(
    function* (projectRoot: string, branch: string) {
      const listed = yield* git.listRefs({
        cwd: projectRoot,
        query: branch,
        refKind: "local",
        refresh: true,
        limit: 100,
      });
      return listed.refs.find((ref) => !ref.isRemote && ref.name === branch) ?? null;
    },
  );

  const proveLiveGitOwnershipAndCleanliness = Effect.fn(
    "ScheduledAutomationWorktreePruner.proveLiveGitOwnershipAndCleanliness",
  )(function* (
    thread: OrchestrationThreadShell & { readonly worktreePath: string },
    project: OrchestrationProjectShell,
    expectedBranch: string,
    createdAt: string,
  ) {
    const [canonicalRoot, canonicalCandidate] = yield* Effect.all([
      canonicalize(path.resolve(config.worktreesDir, SCHEDULED_AUTOMATION_WORKTREE_SUBTREE)),
      canonicalize(thread.worktreePath),
    ]);
    if (canonicalRoot === null || canonicalCandidate === null) {
      return yield* block(thread, "worktree-path-canonicalization-failed", createdAt);
    }
    const relative = path.relative(canonicalRoot, canonicalCandidate);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      return yield* block(thread, "worktree-path-outside-root", createdAt);
    }

    const listed = yield* Effect.result(findRegisteredRef(project.workspaceRoot, expectedBranch));
    if (Result.isFailure(listed)) return yield* block(thread, "git-list-failed", createdAt);
    if (listed.success?.worktreePath === null || listed.success === null) {
      return yield* block(thread, "git-list-mismatch", createdAt);
    }
    const canonicalRegistered = yield* canonicalize(listed.success.worktreePath);
    if (
      canonicalRegistered === null ||
      canonicalPathIdentity(canonicalRegistered) !== canonicalPathIdentity(canonicalCandidate)
    ) {
      return yield* block(thread, "git-list-mismatch", createdAt);
    }

    yield* git.invalidateLocalStatus(thread.worktreePath);
    const status = yield* Effect.result(git.localStatus({ cwd: thread.worktreePath }));
    if (Result.isFailure(status) || !status.success.isRepo) {
      return yield* block(thread, "git-status-failed", createdAt);
    }
    if (status.success.hasWorkingTreeChanges) {
      return yield* block(thread, "dirty-worktree", createdAt);
    }
    return "eligible" as const;
  });

  const pruneCandidate = Effect.fn("ScheduledAutomationWorktreePruner.pruneCandidate")(function* (
    thread: OrchestrationThreadShell,
    project: OrchestrationProjectShell | undefined,
    nowMillis: number,
    retentionDays: number,
    createdAt: string,
  ) {
    const identity = parseScheduledAutomationThreadIdentity(thread.id);
    if (identity === null) return "deferred" as const;
    if (project === undefined) return yield* block(thread, "project-missing", createdAt);
    const activitiesResult = yield* Effect.result(
      projectionActivities.listByThreadId({ threadId: thread.id }),
    );
    if (Result.isFailure(activitiesResult)) {
      return yield* block(thread, "projection-refresh-failed", createdAt);
    }
    const activities = activitiesResult.success;
    if (hasPrunedActivity(activities)) return "deferred" as const;
    if (isScheduledAutomationThreadActive(thread, { now: createdAt })) return "deferred" as const;
    if (nowMillis - latestMeaningfulActivityAt(thread, activities) < retentionDays * DAY_MILLIS) {
      return "deferred" as const;
    }

    const expectedBranch = `t3/local-scheduled-automation/${identity.automationKey}/${identity.occurrenceKey}`;
    if (thread.branch !== expectedBranch) return yield* block(thread, "branch-mismatch", createdAt);
    if (thread.worktreePath === null) {
      return yield* block(thread, "worktree-path-missing", createdAt);
    }
    const expectedPath = path.resolve(
      config.worktreesDir,
      SCHEDULED_AUTOMATION_WORKTREE_SUBTREE,
      identity.automationKey,
      identity.occurrenceKey,
    );
    if (
      canonicalPathIdentity(path.resolve(thread.worktreePath)) !==
      canonicalPathIdentity(expectedPath)
    ) {
      return yield* block(thread, "worktree-path-mismatch", createdAt);
    }

    if (!(yield* fileSystem.exists(thread.worktreePath))) {
      const removedRef = yield* Effect.result(
        findRegisteredRef(project.workspaceRoot, expectedBranch),
      );
      if (Result.isFailure(removedRef)) {
        yield* Effect.logWarning("Failed to reconcile an absent automation worktree", {
          threadId: thread.id,
          error: String(removedRef.failure),
        });
        return "deferred" as const;
      }
      if (removedRef.success !== null && removedRef.success.worktreePath === null) {
        return yield* markPruned(thread, createdAt);
      }
      return yield* block(thread, "git-list-mismatch", createdAt);
    }

    const initialGitProof = yield* proveLiveGitOwnershipAndCleanliness(
      thread as OrchestrationThreadShell & { readonly worktreePath: string },
      project,
      expectedBranch,
      createdAt,
    );
    if (initialGitProof !== "eligible") return initialGitProof;

    const refreshed = yield* Effect.result(
      Effect.all({
        thread: projections.getRetainedThreadShellById(thread.id),
        project: projections.getProjectShellById(thread.projectId),
      }),
    );
    if (Result.isFailure(refreshed)) {
      return yield* block(thread, "projection-refresh-failed", createdAt);
    }
    if (Option.isNone(refreshed.success.thread) || Option.isNone(refreshed.success.project)) {
      return "deferred" as const;
    }
    const freshThread = refreshed.success.thread.value;
    const freshProject = refreshed.success.project.value;
    if (
      freshThread.branch !== thread.branch ||
      freshThread.worktreePath !== thread.worktreePath ||
      freshProject.workspaceRoot !== project.workspaceRoot
    ) {
      return yield* block(thread, "ownership-changed", createdAt);
    }
    if (isScheduledAutomationThreadActive(freshThread, { now: createdAt })) {
      return "deferred" as const;
    }

    const freshActivitiesResult = yield* Effect.result(
      projectionActivities.listByThreadId({ threadId: freshThread.id }),
    );
    if (Result.isFailure(freshActivitiesResult)) {
      return yield* block(thread, "projection-refresh-failed", createdAt);
    }
    if (hasPrunedActivity(freshActivitiesResult.success)) return "deferred" as const;
    if (
      nowMillis - latestMeaningfulActivityAt(freshThread, freshActivitiesResult.success) <
      retentionDays * DAY_MILLIS
    ) {
      return "deferred" as const;
    }

    const finalGitProof = yield* proveLiveGitOwnershipAndCleanliness(
      freshThread as OrchestrationThreadShell & { readonly worktreePath: string },
      freshProject,
      expectedBranch,
      createdAt,
    );
    if (finalGitProof !== "eligible") return finalGitProof;

    const removed = yield* Effect.result(
      git.removeWorktree({
        cwd: freshProject.workspaceRoot,
        path: freshThread.worktreePath,
        force: false,
      }),
    );
    if (Result.isFailure(removed)) return yield* block(thread, "remove-failed", createdAt);

    const [registeredAfter, pathStillExists] = yield* Effect.all([
      Effect.result(findRegisteredRef(freshProject.workspaceRoot, expectedBranch)),
      fileSystem.exists(freshThread.worktreePath),
    ]);
    if (Result.isFailure(registeredAfter)) {
      yield* Effect.logWarning("Failed to verify a removed automation worktree", {
        threadId: thread.id,
        error: String(registeredAfter.failure),
      });
      return "deferred" as const;
    }
    if (registeredAfter.success?.worktreePath != null || pathStillExists) {
      return yield* block(thread, "remove-verification-failed", createdAt);
    }
    if (registeredAfter.success === null) {
      return yield* block(thread, "remove-verification-failed", createdAt);
    }
    return yield* markPruned(thread, createdAt);
  });

  const runOnce = Effect.gen(function* () {
    const [activeShells, archivedShells, serverSettings, nowMillis] = yield* Effect.all([
      projections.getShellSnapshot(),
      projections.getArchivedShellSnapshot(),
      settings.getSettings,
      Clock.currentTimeMillis,
    ]);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const projects = new Map(
      [...activeShells.projects, ...archivedShells.projects].map(
        (project) => [project.id, project] as const,
      ),
    );
    const candidates = [
      ...new Map(
        [...activeShells.threads, ...archivedShells.threads].map(
          (thread) => [thread.id, thread] as const,
        ),
      ).values(),
    ].filter((thread) => parseScheduledAutomationThreadIdentity(thread.id) !== null);
    const results = yield* Effect.forEach(
      candidates,
      (thread) =>
        pruneCandidate(
          thread,
          projects.get(thread.projectId),
          nowMillis,
          serverSettings.localScheduledAutomationWorktreeRetentionDays,
          createdAt,
        ),
      { concurrency: 1 },
    );
    return {
      candidates: candidates.length,
      pruned: results.filter((result) => result === "pruned").length,
      blocked: results.filter((result) => result === "blocked").length,
      deferred: results.filter((result) => result === "deferred").length,
    };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Scheduled automation worktree housekeeping failed", {
        cause: Cause.pretty(cause),
      }).pipe(Effect.as({ candidates: 0, pruned: 0, blocked: 0, deferred: 0 })),
    ),
  );

  const run = Effect.forever(
    runOnce.pipe(
      Effect.tap((summary) => options.onRunComplete?.(summary) ?? Effect.void),
      Effect.andThen(Effect.sleep(SCHEDULED_AUTOMATION_WORKTREE_HOUSEKEEPING_INTERVAL)),
    ),
  );
  return ScheduledAutomationWorktreePruner.of({ runOnce, run });
});

export const layer = Layer.effect(
  ScheduledAutomationWorktreePruner,
  makeScheduledAutomationWorktreePruner(),
);

export const launch = Effect.flatMap(ScheduledAutomationWorktreePruner, (pruner) =>
  pruner.run.pipe(Effect.forkScoped, Effect.asVoid),
);
