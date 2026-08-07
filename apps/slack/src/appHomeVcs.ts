import { applyGitStatusStreamEvent } from "@t3tools/shared/git";
import type { OrchestrationShellSnapshot, VcsStatusResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import type { T3Transport } from "@t3tools/integration-runtime";

const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAXIMUM_RETRY_DELAY_MS = 30_000;

export function selectAppHomeVcsTargets(snapshot: OrchestrationShellSnapshot): ReadonlySet<string> {
  const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
  const targets = new Set<string>();
  for (const thread of snapshot.threads) {
    // Keep snoozed conversations subscribed so their status is ready when the
    // App Home publisher's wake timer makes them visible without a new snapshot.
    if (thread.archivedAt !== null || thread.branch === null) continue;
    if (
      thread.settledOverride === "settled" &&
      !thread.hasPendingApprovals &&
      !thread.hasPendingUserInput
    ) {
      continue;
    }
    const project = projects.get(thread.projectId);
    if (!project) continue;
    const cwd = thread.worktreePath ?? project.workspaceRoot;
    if (cwd) targets.add(cwd);
  }
  return targets;
}

export interface AppHomeVcsProjection {
  readonly updated: (snapshot: OrchestrationShellSnapshot) => void;
  readonly stop: () => Promise<void>;
}

export function makeAppHomeVcsProjection(input: {
  readonly transport: T3Transport;
  readonly onUpdated: (statuses: ReadonlyMap<string, VcsStatusResult>) => void;
  readonly onError?: (error: unknown, cwd: string) => void;
  readonly retryDelayMs?: number;
  readonly maximumRetryDelayMs?: number;
  readonly sleep?: (delayMs: number) => Effect.Effect<void>;
}): AppHomeVcsProjection {
  type ActiveTarget = {
    fiber: ReturnType<typeof Effect.runFork> | null;
  };

  const active = new Map<string, ActiveTarget>();
  const statuses = new Map<string, VcsStatusResult>();
  const retryDelayMs = input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maximumRetryDelayMs = input.maximumRetryDelayMs ?? MAXIMUM_RETRY_DELAY_MS;
  const sleep = input.sleep ?? ((delayMs: number) => Effect.sleep(delayMs));
  let stopped = false;

  const publish = (): void => {
    try {
      input.onUpdated(new Map(statuses));
    } catch (error) {
      try {
        input.onError?.(error, "projection");
      } catch {
        // Diagnostics must not terminate status subscriptions.
      }
    }
  };

  const reportError = (error: unknown, cwd: string): void => {
    try {
      input.onError?.(error, cwd);
    } catch {
      // Diagnostics must not terminate status subscriptions.
    }
  };

  const runTarget = (cwd: string, target: ActiveTarget) =>
    Effect.gen(function* () {
      let nextRetryDelayMs = retryDelayMs;
      while (active.get(cwd) === target) {
        const result = yield* Effect.exit(
          input.transport.subscribeVcsStatus({ cwd }).pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (stopped || active.get(cwd) !== target) return;
                const next = applyGitStatusStreamEvent(statuses.get(cwd) ?? null, event);
                statuses.set(cwd, next);
                nextRetryDelayMs = retryDelayMs;
                publish();
              }),
            ),
          ),
        );
        if (stopped || active.get(cwd) !== target) return;
        if (Exit.isFailure(result)) reportError(Cause.squash(result.cause), cwd);
        yield* sleep(nextRetryDelayMs);
        nextRetryDelayMs = Math.min(maximumRetryDelayMs, nextRetryDelayMs * 2);
      }
    });

  const startTarget = (cwd: string): void => {
    const target: ActiveTarget = { fiber: null };
    active.set(cwd, target);
    target.fiber = Effect.runFork(runTarget(cwd, target));
  };

  const removeTarget = (cwd: string): ReturnType<typeof Effect.runFork> | null => {
    const target = active.get(cwd);
    if (!target) return null;
    active.delete(cwd);
    statuses.delete(cwd);
    return target.fiber;
  };

  return {
    updated: (snapshot) => {
      if (stopped) return;
      const nextTargets = selectAppHomeVcsTargets(snapshot);
      const removedFibers: Array<ReturnType<typeof Effect.runFork>> = [];
      let removedStatus = false;
      for (const cwd of active.keys()) {
        if (nextTargets.has(cwd)) continue;
        removedStatus ||= statuses.has(cwd);
        const fiber = removeTarget(cwd);
        if (fiber) removedFibers.push(fiber);
      }
      for (const cwd of nextTargets) {
        if (!active.has(cwd)) startTarget(cwd);
      }
      for (const fiber of removedFibers) void Effect.runPromise(Fiber.interrupt(fiber));
      if (removedStatus) publish();
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      const fibers = [...active.values()].flatMap((target) =>
        target.fiber === null ? [] : [target.fiber],
      );
      active.clear();
      statuses.clear();
      await Promise.allSettled(fibers.map((fiber) => Effect.runPromise(Fiber.interrupt(fiber))));
    },
  };
}
