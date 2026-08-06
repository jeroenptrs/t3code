import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadShell,
  ServerSettings,
  VcsRef,
} from "@t3tools/contracts";
import {
  EventId,
  GitCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadActivityRepository } from "../persistence/Services/ProjectionThreadActivities.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  launch,
  makeScheduledAutomationWorktreePruner,
  ScheduledAutomationWorktreePruner,
  type ScheduledAutomationWorktreePrunerShape,
  type ScheduledAutomationWorktreePruneSummary,
} from "./ScheduledAutomationWorktreePruner.ts";

const NOW = "2026-08-20T00:00:00.000Z";
const OLD = "2026-08-01T00:00:00.000Z";
const RECENT = "2026-08-19T00:00:00.000Z";
const AUTOMATION_ID = "nightly";
const SCHEDULED_FOR = "2026-08-01T00:00:00.000Z";
const AUTOMATION_KEY = Encoding.encodeHex(AUTOMATION_ID);
const OCCURRENCE_KEY = Encoding.encodeHex(SCHEDULED_FOR);
const THREAD_ID = ThreadId.make(`t3sa:v1:${AUTOMATION_KEY}:${OCCURRENCE_KEY}:thread`);
const BRANCH = `t3/local-scheduled-automation/${AUTOMATION_KEY}/${OCCURRENCE_KEY}`;
const PROJECT_ID = ProjectId.make("project-1");

type FixtureOptions = {
  readonly threadId?: string;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly missingProject?: boolean;
  readonly archived?: boolean;
  readonly shell?: Partial<OrchestrationThreadShell>;
  readonly freshShell?: Partial<OrchestrationThreadShell>;
  readonly updatedAt?: string;
  readonly gitWorktreePath?: string | null;
  readonly gitListFails?: boolean;
  readonly gitListFailureCalls?: ReadonlyArray<number>;
  readonly gitWorktreePathSequence?: ReadonlyArray<string | null>;
  readonly statusFails?: boolean;
  readonly dirtySequence?: ReadonlyArray<boolean>;
  readonly activityQueryFails?: boolean;
  readonly freshActivityAt?: string;
  readonly dirty?: boolean;
  readonly removeFails?: boolean;
  readonly prunedActivityFailures?: number;
  readonly retentionDays?: number;
  readonly onRunComplete?: (
    summary: ScheduledAutomationWorktreePruneSummary,
  ) => Effect.Effect<void>;
};

interface Harness {
  readonly root: string;
  readonly candidatePath: string;
  readonly state: {
    readonly removeInputs: Array<{ cwd: string; path: string; force?: boolean }>;
    readonly commands: Array<OrchestrationCommand>;
    readonly registeredPath: Ref.Ref<string | null>;
    readonly rawRemoveCalls: Array<string>;
  };
  readonly pruner: ScheduledAutomationWorktreePrunerShape;
  readonly runOnce: Effect.Effect<ScheduledAutomationWorktreePruneSummary>;
}

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" } as const;

const gitError = (operation: string) =>
  new GitCommandError({ operation, command: "git", cwd: "/test", detail: "test failure" });

const makeHarness = Effect.fn("test.makeScheduledAutomationPrunerHarness")(function* (
  options: FixtureOptions = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "automation-pruner-" });
  const worktreesDir = path.join(temp, "worktrees");
  const root = path.join(worktreesDir, "local-scheduled-automations-v1");
  const candidatePath = path.join(root, AUTOMATION_KEY, OCCURRENCE_KEY);
  yield* fileSystem.makeDirectory(candidatePath, { recursive: true });
  const outsidePath = path.join(temp, "outside");
  yield* fileSystem.makeDirectory(outsidePath, { recursive: true });
  const projectRoot = path.join(temp, "project");
  yield* fileSystem.makeDirectory(projectRoot, { recursive: true });

  const threadId = ThreadId.make(options.threadId ?? THREAD_ID);
  const worktreePath =
    options.worktreePath === undefined
      ? candidatePath
      : options.worktreePath === "$ROOT"
        ? root
        : options.worktreePath === "$OUTSIDE"
          ? outsidePath
          : options.worktreePath;
  const activities: Array<OrchestrationThread["activities"][number]> = [];
  const thread: OrchestrationThread = {
    id: threadId,
    projectId: PROJECT_ID,
    title: "Automation: nightly",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: options.branch === undefined ? BRANCH : options.branch,
    worktreePath,
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "completed",
      requestedAt: options.updatedAt ?? OLD,
      startedAt: options.updatedAt ?? OLD,
      completedAt: options.updatedAt ?? OLD,
      assistantMessageId: null,
    },
    createdAt: OLD,
    updatedAt: options.updatedAt ?? OLD,
    archivedAt: options.archived ? OLD : null,
    settledOverride: "active",
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    titleRegeneration: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities,
    checkpoints: [],
    session: null,
  };
  const shell: OrchestrationThreadShell = {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: options.archived ? OLD : null,
    settledOverride: thread.settledOverride,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    titleRegeneration: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...options.shell,
  };
  const project: OrchestrationProject = {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: projectRoot,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: OLD,
    updatedAt: OLD,
    deletedAt: options.missingProject ? OLD : null,
  };
  const shellSnapshot: OrchestrationShellSnapshot = {
    snapshotSequence: 1,
    projects: options.missingProject ? [] : [project],
    threads: options.archived ? [] : [shell],
    updatedAt: OLD,
  };
  const archivedShellSnapshot: OrchestrationShellSnapshot = {
    ...shellSnapshot,
    threads: options.archived ? [shell] : [],
  };

  const removeInputs: Harness["state"]["removeInputs"] = [];
  const commands: Harness["state"]["commands"] = [];
  const rawRemoveCalls: Array<string> = [];
  let listCall = 0;
  let statusCall = 0;
  let activityQueryCall = 0;
  let remainingPrunedActivityFailures = options.prunedActivityFailures ?? 0;
  const registeredPath = yield* Ref.make<string | null>(
    options.gitWorktreePath === undefined ? candidatePath : options.gitWorktreePath,
  );
  const guardedFileSystem = new Proxy(fileSystem, {
    get(target, property, receiver) {
      if (property !== "remove") return Reflect.get(target, property, receiver);
      return (targetPath: string) =>
        Effect.sync(() => {
          rawRemoveCalls.push(targetPath);
          throw new Error("pruner must not remove worktrees through FileSystem.remove");
        });
    },
  });
  const prunerOptions =
    options.onRunComplete === undefined ? {} : { onRunComplete: options.onRunComplete };
  const pruner = yield* makeScheduledAutomationWorktreePruner(prunerOptions).pipe(
    Effect.provideService(FileSystem.FileSystem, guardedFileSystem),
    Effect.provideService(ServerConfig, { worktreesDir } as ServerConfig["Service"]),
    Effect.provideService(ServerSettingsService, {
      getSettings: Effect.succeed({
        localScheduledAutomationWorktreeRetentionDays: options.retentionDays ?? 7,
      } as ServerSettings),
    } as unknown as ServerSettingsService["Service"]),
    Effect.provideService(ProjectionSnapshotQuery, {
      getShellSnapshot: () => Effect.succeed(shellSnapshot),
      getArchivedShellSnapshot: () => Effect.succeed(archivedShellSnapshot),
      getRetainedThreadShellById: () =>
        Effect.succeed(Option.some({ ...shell, ...options.freshShell })),
      getProjectShellById: () =>
        Effect.succeed(options.missingProject ? Option.none() : Option.some(project)),
    } as unknown as ProjectionSnapshotQuery["Service"]),
    Effect.provideService(ProjectionThreadActivityRepository, {
      listByThreadId: () =>
        options.activityQueryFails
          ? Effect.fail(gitError("listActivities"))
          : Effect.sync(() => {
              activityQueryCall += 1;
              const current = [...activities];
              if (activityQueryCall > 1 && options.freshActivityAt !== undefined) {
                current.push({
                  id: EventId.make("fresh-race-activity"),
                  tone: "info",
                  kind: "thread.archived",
                  summary: "Archived while pruning.",
                  payload: {},
                  turnId: null,
                  createdAt: options.freshActivityAt,
                });
              }
              return current.map((activity) => ({
                activityId: activity.id,
                threadId: thread.id,
                turnId: activity.turnId,
                tone: activity.tone,
                kind: activity.kind,
                summary: activity.summary,
                payload: activity.payload,
                ...(activity.sequence === undefined ? {} : { sequence: activity.sequence }),
                createdAt: activity.createdAt,
              }));
            }),
    } as unknown as ProjectionThreadActivityRepository["Service"]),
    Effect.provideService(OrchestrationEngineService, {
      dispatch: (command: OrchestrationCommand) =>
        Effect.gen(function* () {
          if (
            command.type === "thread.activity.append" &&
            command.activity.kind === "local-scheduled-automation.worktree.pruned" &&
            remainingPrunedActivityFailures > 0
          ) {
            remainingPrunedActivityFailures -= 1;
            return yield* gitError("appendPrunedActivity");
          }
          if (!commands.some((existing) => existing.commandId === command.commandId)) {
            commands.push(command);
            if (command.type === "thread.activity.append") activities.push(command.activity);
          }
          return { sequence: commands.length };
        }),
    } as unknown as OrchestrationEngineService["Service"]),
    Effect.provideService(GitWorkflowService, {
      listRefs: () =>
        ((listCall += 1),
        options.gitListFails || options.gitListFailureCalls?.includes(listCall) === true)
          ? Effect.fail(gitError("listRefs"))
          : Ref.get(registeredPath).pipe(
              Effect.map((registered) => {
                const sequence = options.gitWorktreePathSequence;
                const currentPath =
                  sequence !== undefined && listCall <= sequence.length
                    ? sequence[listCall - 1] === "$CANDIDATE"
                      ? candidatePath
                      : (sequence[listCall - 1] ?? null)
                    : registered;
                return {
                  refs: [
                    {
                      name: BRANCH,
                      current: currentPath !== null,
                      isDefault: false,
                      worktreePath: currentPath,
                    } satisfies VcsRef,
                  ],
                  isRepo: true,
                  hasPrimaryRemote: false,
                  nextCursor: null,
                  totalCount: 1,
                };
              }),
            ),
      invalidateLocalStatus: () => Effect.void,
      localStatus: () =>
        ((statusCall += 1), options.statusFails)
          ? Effect.fail(gitError("localStatus"))
          : Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: false,
              isDefaultRef: false,
              refName: BRANCH,
              hasWorkingTreeChanges:
                options.dirtySequence?.[statusCall - 1] ?? options.dirty ?? false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
      removeWorktree: (input: { cwd: string; path: string; force?: boolean }) =>
        Effect.gen(function* () {
          removeInputs.push(input);
          if (options.removeFails) return yield* gitError("removeWorktree");
          yield* fileSystem.remove(input.path, { recursive: true });
          yield* Ref.set(registeredPath, null);
        }),
    } as unknown as GitWorkflowService["Service"]),
  );

  return {
    root,
    candidatePath,
    state: { removeInputs, commands, registeredPath, rawRemoveCalls },
    pruner,
    runOnce: pruner.runOnce,
  } satisfies Harness;
});

const withNode = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer));

describe("ScheduledAutomationWorktreePruner safety", () => {
  const refusalCases: ReadonlyArray<{
    readonly name: string;
    readonly options: FixtureOptions;
  }> = [
    {
      name: "unknown ID prefix",
      options: { threadId: `other:${AUTOMATION_KEY}:${OCCURRENCE_KEY}:thread` },
    },
    {
      name: "unknown ID version",
      options: { threadId: `t3sa:v2:${AUTOMATION_KEY}:${OCCURRENCE_KEY}:thread` },
    },
    { name: "branch mismatch", options: { branch: `${BRANCH}-other` } },
    { name: "path outside worktree root", options: { worktreePath: "$OUTSIDE" } },
    { name: "path equal to root", options: { worktreePath: "$ROOT" } },
    { name: "Git list mismatch", options: { gitWorktreePath: null } },
    { name: "Git list error", options: { gitListFails: true } },
    { name: "missing worktree path", options: { worktreePath: null } },
    { name: "missing project", options: { missingProject: true } },
    { name: "active session", options: { shell: { session: { status: "running" } as never } } },
    { name: "pending approval", options: { shell: { hasPendingApprovals: true } } },
    { name: "pending input", options: { shell: { hasPendingUserInput: true } } },
    {
      name: "queued turn",
      options: { shell: { latestUserMessageAt: "2026-08-19T23:59:00.000Z" } },
    },
    {
      name: "running latest turn",
      options: { shell: { latestTurn: { state: "running" } as never } },
    },
    { name: "recent activity", options: { updatedAt: RECENT } },
    { name: "dirty working tree", options: { dirty: true } },
    { name: "Git status error", options: { statusFails: true } },
    { name: "activity projection error", options: { activityQueryFails: true } },
    {
      name: "thread that becomes active immediately before removal",
      options: { freshShell: { session: { status: "running" } as never } },
    },
  ];

  for (const fixture of refusalCases) {
    it.effect(`refuses ${fixture.name}`, () =>
      withNode(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const harness = yield* makeHarness(fixture.options);
          yield* harness.runOnce;
          expect(harness.state.removeInputs).toHaveLength(0);
          expect(
            yield* FileSystem.FileSystem.pipe(
              Effect.flatMap((fs) => fs.exists(harness.candidatePath)),
            ),
          ).toBe(true);
        }),
      ),
    );
  }

  it.effect("refuses a canonical symlink escape", () =>
    withNode(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const harness = yield* makeHarness();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = path.join(path.dirname(harness.root), "outside");
        yield* fileSystem.makeDirectory(outside, { recursive: true });
        yield* fileSystem.remove(harness.candidatePath, { recursive: true });
        yield* fileSystem.symlink(outside, harness.candidatePath);
        yield* harness.runOnce;
        expect(harness.state.removeInputs).toHaveLength(0);
      }),
    ),
  );

  it.effect("prunes a completed-but-unsettled clean run and always passes force false", () =>
    withNode(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const harness = yield* makeHarness({ shell: { settledOverride: "active" } });
        const summary = yield* harness.runOnce;
        expect(summary.pruned).toBe(1);
        expect(harness.state.rawRemoveCalls).toEqual([]);
        expect(harness.state.removeInputs).toEqual([
          { cwd: expect.any(String), path: harness.candidatePath, force: false },
        ]);
        expect(
          yield* FileSystem.FileSystem.pipe(
            Effect.flatMap((fs) => fs.exists(harness.candidatePath)),
          ),
        ).toBe(false);
      }),
    ),
  );

  it.effect("deduplicates a dirty-worktree blocked activity by candidate and reason", () =>
    withNode(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const harness = yield* makeHarness({ dirty: true });
        yield* harness.runOnce;
        yield* harness.runOnce;
        const blocked = harness.state.commands.filter(
          (command) =>
            command.type === "thread.activity.append" &&
            command.activity.kind === "local-scheduled-automation.worktree.prune-blocked",
        );
        expect(blocked).toHaveLength(1);
        const activity = blocked[0];
        assert(activity?.type === "thread.activity.append");
        expect(activity.activity.payload).toEqual({ reason: "dirty-worktree" });
        expect(yield* Ref.get(harness.state.registeredPath)).toBe(harness.candidatePath);
        expect(
          yield* FileSystem.FileSystem.pipe(
            Effect.flatMap((fs) => fs.exists(harness.candidatePath)),
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("is idempotent after a successful prune", () =>
    withNode(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const harness = yield* makeHarness();
        yield* harness.runOnce;
        const second = yield* harness.runOnce;
        expect(second.pruned).toBe(0);
        expect(harness.state.removeInputs).toHaveLength(1);
        expect(
          harness.state.commands.filter(
            (command) =>
              command.type === "thread.activity.append" &&
              command.activity.kind === "local-scheduled-automation.worktree.pruned",
          ),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("reconciles a removed worktree after pruned activity dispatch transiently fails", () =>
    withNode(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const harness = yield* makeHarness({ prunedActivityFailures: 1 });
        expect(yield* harness.runOnce).toMatchObject({ pruned: 0, deferred: 1 });
        expect(harness.state.removeInputs).toHaveLength(1);
        expect(
          yield* FileSystem.FileSystem.pipe(
            Effect.flatMap((fs) => fs.exists(harness.candidatePath)),
          ),
        ).toBe(false);

        expect(yield* harness.runOnce).toMatchObject({ pruned: 1, deferred: 0 });
        expect(harness.state.removeInputs).toHaveLength(1);
        expect(
          harness.state.commands.filter(
            (command) =>
              command.type === "thread.activity.append" &&
              command.activity.kind === "local-scheduled-automation.worktree.pruned",
          ),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect(
    "reconciles a removed worktree after post-remove Git verification transiently fails",
    () =>
      withNode(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const harness = yield* makeHarness({ gitListFailureCalls: [3] });
          expect(yield* harness.runOnce).toMatchObject({ pruned: 0, deferred: 1 });
          expect(harness.state.removeInputs).toHaveLength(1);
          expect(yield* harness.runOnce).toMatchObject({ pruned: 1, deferred: 0 });
          expect(harness.state.removeInputs).toHaveLength(1);
        }),
      ),
  );

  it.effect("rechecks meaningful activity immediately before removal", () =>
    withNode(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const harness = yield* makeHarness({ freshActivityAt: RECENT });
        expect(yield* harness.runOnce).toMatchObject({ deferred: 1 });
        expect(harness.state.removeInputs).toHaveLength(0);

        const newlyArchived = yield* makeHarness({
          freshShell: { archivedAt: RECENT, updatedAt: RECENT },
        });
        expect(yield* newlyArchived.runOnce).toMatchObject({ deferred: 1 });
        expect(newlyArchived.state.removeInputs).toHaveLength(0);
      }),
    ),
  );

  it.effect("retains the worktree and records a block when non-force Git removal fails", () =>
    withNode(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const harness = yield* makeHarness({ removeFails: true });
        expect(yield* harness.runOnce).toMatchObject({ blocked: 1, pruned: 0 });
        expect(harness.state.removeInputs).toEqual([
          { cwd: expect.any(String), path: harness.candidatePath, force: false },
        ]);
        expect(yield* Ref.get(harness.state.registeredPath)).toBe(harness.candidatePath);
        expect(
          yield* FileSystem.FileSystem.pipe(
            Effect.flatMap((fs) => fs.exists(harness.candidatePath)),
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("rechecks live Git registration and status immediately before removal", () =>
    withNode(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const changedRegistration = yield* makeHarness({
          gitWorktreePathSequence: ["$CANDIDATE", null],
        });
        expect(yield* changedRegistration.runOnce).toMatchObject({ blocked: 1 });
        expect(changedRegistration.state.removeInputs).toHaveLength(0);

        const newlyDirty = yield* makeHarness({ dirtySequence: [false, true] });
        expect(yield* newlyDirty.runOnce).toMatchObject({ blocked: 1 });
        expect(newlyDirty.state.removeInputs).toHaveLength(0);
      }),
    ),
  );

  it.effect("runs immediately, repeats every six hours, and stops with its scope", () =>
    withNode(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const firstRun = yield* Deferred.make<void>();
        const secondRun = yield* Deferred.make<void>();
        const completedRuns = yield* Ref.make(0);
        const harness = yield* makeHarness({
          retentionDays: 30,
          onRunComplete: () =>
            Ref.updateAndGet(completedRuns, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Deferred.succeed(firstRun, undefined)
                  : count === 2
                    ? Deferred.succeed(secondRun, undefined)
                    : Effect.void,
              ),
              Effect.asVoid,
            ),
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* launch.pipe(
              Effect.provideService(ScheduledAutomationWorktreePruner, harness.pruner),
            );
            yield* Deferred.await(firstRun);
            expect(yield* Ref.get(completedRuns)).toBe(1);
            yield* TestClock.adjust(Duration.hours(6));
            yield* Deferred.await(secondRun);
            expect(yield* Ref.get(completedRuns)).toBe(2);
          }),
        );

        yield* TestClock.adjust(Duration.hours(12));
        expect(yield* Ref.get(completedRuns)).toBe(2);
      }),
    ),
  );

  it.effect("applies the current global retention to archived runs without definition rows", () =>
    withNode(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const retained = yield* makeHarness({ retentionDays: 30, archived: true });
        expect((yield* retained.runOnce).deferred).toBe(1);
        expect(retained.state.removeInputs).toHaveLength(0);

        const pruned = yield* makeHarness({ retentionDays: 1, archived: true });
        expect((yield* pruned.runOnce).pruned).toBe(1);
      }),
    ),
  );
});
