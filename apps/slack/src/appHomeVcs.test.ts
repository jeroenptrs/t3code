import { describe, expect, it, vi } from "vite-plus/test";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { T3TransportError, type T3Transport } from "@t3tools/integration-runtime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { makeAppHomeVcsProjection, selectAppHomeVcsTargets } from "./appHomeVcs.ts";

const NOW = "2026-08-07T12:00:00.000Z";
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
};

const project = (id: string, workspaceRoot = `/workspace/${id}`): OrchestrationProjectShell =>
  ({
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    defaultModelSelection: modelSelection,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  }) as OrchestrationProjectShell;

const thread = (input: {
  readonly id: string;
  readonly projectId?: string;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly archived?: boolean;
  readonly settled?: boolean;
  readonly pendingApproval?: boolean;
  readonly snoozed?: boolean;
}): OrchestrationThreadShell =>
  ({
    id: ThreadId.make(input.id),
    projectId: ProjectId.make(input.projectId ?? "project-a"),
    title: input.id,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: input.branch === undefined ? "feature/live-pr" : input.branch,
    worktreePath: input.worktreePath ?? null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: input.archived ? NOW : null,
    settledOverride: input.settled ? "settled" : null,
    settledAt: input.settled ? NOW : null,
    snoozedUntil: input.snoozed ? "2026-08-08T12:00:00.000Z" : null,
    snoozedAt: input.snoozed ? NOW : null,
    session: null,
    latestUserMessageAt: NOW,
    hasPendingApprovals: input.pendingApproval ?? false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  }) as OrchestrationThreadShell;

const snapshot = (threads: ReadonlyArray<OrchestrationThreadShell>): OrchestrationShellSnapshot =>
  ({
    snapshotSequence: 1,
    projects: [project("project-a")],
    threads,
    updatedAt: NOW,
  }) as OrchestrationShellSnapshot;

const vcsSnapshot = (cwd: string): VcsStatusStreamEvent => ({
  _tag: "snapshot",
  local: {
    isRepo: true,
    sourceControlProvider: { kind: "gitlab", name: "GitLab", baseUrl: "https://gitlab.com" },
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/live-pr",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
  },
  remote: {
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: {
      number: cwd.length,
      title: "Live merge request",
      url: "https://gitlab.com/example/project/-/merge_requests/19",
      baseRef: "main",
      headRef: "feature/live-pr",
      state: "open",
    },
  },
});

const transport = (subscribeVcsStatus: T3Transport["subscribeVcsStatus"]): T3Transport => ({
  close: () => Effect.void,
  validateSession: () => Effect.die("not used"),
  getShellSnapshot: () => Effect.die("not used"),
  subscribeShell: () => Stream.never,
  getThreadSnapshot: () => Effect.die("not used"),
  dispatch: () => Effect.die("not used"),
  getServerConfig: () => Effect.die("not used"),
  listRefs: () => Effect.die("not used"),
  subscribeVcsStatus,
  switchRef: () => Effect.die("not used"),
  dispatchBootstrap: () => Effect.die("not used"),
});

describe("Slack App Home VCS projection", () => {
  it("deduplicates active workspace targets and ignores inactive conversations", () => {
    expect(
      selectAppHomeVcsTargets(
        snapshot([
          thread({ id: "project-workspace" }),
          thread({ id: "same-project-workspace" }),
          thread({ id: "worktree", worktreePath: "/worktrees/live" }),
          thread({ id: "archived", archived: true }),
          thread({ id: "settled", settled: true }),
          thread({ id: "blocked-settled", settled: true, pendingApproval: true }),
          thread({ id: "no-branch", branch: null }),
          thread({ id: "snoozed", snoozed: true, worktreePath: "/worktrees/snoozed" }),
          thread({
            id: "missing-project",
            projectId: "missing",
            worktreePath: "/worktrees/orphaned",
          }),
        ]),
      ),
    ).toEqual(new Set(["/workspace/project-a", "/worktrees/live", "/worktrees/snoozed"]));
  });

  it("publishes live status and releases a removed workspace subscription", async () => {
    let resolveUpdated: ((value: ReadonlyMap<string, unknown>) => void) | null = null;
    const updated = new Promise<ReadonlyMap<string, unknown>>((resolve) => {
      resolveUpdated = resolve;
    });
    let resolveReleased: (() => void) | null = null;
    const released = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    const subscribed = vi.fn((input: { readonly cwd: string }) =>
      Stream.concat(Stream.make(vcsSnapshot(input.cwd)), Stream.never).pipe(
        Stream.ensuring(Effect.sync(() => resolveReleased?.())),
      ),
    );
    const projection = makeAppHomeVcsProjection({
      transport: transport(subscribed),
      onUpdated: (statuses) => resolveUpdated?.(statuses),
    });

    projection.updated(snapshot([thread({ id: "live", worktreePath: "/worktrees/live" })]));
    const statuses = await updated;
    expect(subscribed).toHaveBeenCalledWith({ cwd: "/worktrees/live" });
    expect(statuses.get("/worktrees/live")).toMatchObject({
      refName: "feature/live-pr",
      pr: { state: "open" },
    });

    projection.updated(snapshot([]));
    await released;
    await projection.stop();
  });

  it("reports failures, retries with backoff, and resets the delay after an event", async () => {
    const sleepCalls: number[] = [];
    const sleepResolvers: Array<() => void> = [];
    let sleepObserved: (() => void) | null = null;
    const waitForSleepCount = async (count: number): Promise<void> => {
      if (sleepCalls.length >= count) return;
      await new Promise<void>((resolve) => {
        sleepObserved = resolve;
      });
    };
    const sleep = (delayMs: number) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            sleepCalls.push(delayMs);
            sleepResolvers.push(resolve);
            sleepObserved?.();
            sleepObserved = null;
          }),
      );
    let attempt = 0;
    const subscribed = vi.fn((input: { readonly cwd: string }) => {
      attempt += 1;
      const failure = Stream.fail(new T3TransportError("unavailable", `failure-${attempt}`, null));
      return attempt === 2 ? Stream.concat(Stream.make(vcsSnapshot(input.cwd)), failure) : failure;
    });
    const errors: unknown[] = [];
    const updates: ReadonlyMap<string, unknown>[] = [];
    const projection = makeAppHomeVcsProjection({
      transport: transport(subscribed),
      onUpdated: (statuses) => updates.push(statuses),
      onError: (error) => errors.push(error),
      retryDelayMs: 10,
      maximumRetryDelayMs: 40,
      sleep,
    });

    projection.updated(snapshot([thread({ id: "live", worktreePath: "/worktrees/live" })]));
    await waitForSleepCount(1);
    expect(sleepCalls).toEqual([10]);
    expect(errors).toHaveLength(1);

    sleepResolvers[0]?.();
    await waitForSleepCount(2);
    expect(sleepCalls).toEqual([10, 10]);
    expect(updates.at(-1)?.get("/worktrees/live")).toMatchObject({
      refName: "feature/live-pr",
    });

    sleepResolvers[1]?.();
    await waitForSleepCount(3);
    expect(sleepCalls).toEqual([10, 10, 20]);
    expect(errors).toHaveLength(3);
    expect(subscribed).toHaveBeenCalledTimes(3);

    await projection.stop();
  });
});
