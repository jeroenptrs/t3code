import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadShell,
  ServerSettings,
} from "@t3tools/contracts";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadActivityRepository } from "../persistence/Services/ProjectionThreadActivities.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { parseScheduledAutomationThreadIdentity } from "./ScheduledAutomationOccurrence.ts";
import { makeScheduledAutomationWorktreePruner } from "./ScheduledAutomationWorktreePruner.ts";

const NOW = "2026-08-20T00:00:00.000Z";
const OLD = "2026-08-01T00:00:00.000Z";
const AUTOMATION_KEY = Encoding.encodeHex("integration-nightly");
const OCCURRENCE_KEY = Encoding.encodeHex(OLD);
const THREAD_ID = ThreadId.make(`t3sa:v1:${AUTOMATION_KEY}:${OCCURRENCE_KEY}:thread`);
const BRANCH = `t3/local-scheduled-automation/${AUTOMATION_KEY}/${OCCURRENCE_KEY}`;

const dirtyIdentity = (name: string) => {
  const automationKey = Encoding.encodeHex(name);
  return {
    threadId: ThreadId.make(`t3sa:v1:${automationKey}:${OCCURRENCE_KEY}:thread`),
    branch: `t3/local-scheduled-automation/${automationKey}/${OCCURRENCE_KEY}`,
    automationKey,
  };
};

const DriverLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(
    Layer.succeed(ServerConfig, {
      worktreesDir: "/tmp/unused-driver-default",
    } as ServerConfig["Service"]),
  ),
);

it.effect("prunes a real clean Git worktree while retaining branch and T3 history", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "automation-pruner-git-" });
    const projectRoot = path.join(temp, "project");
    const worktreesDir = path.join(temp, "worktrees");
    const candidatePath = path.join(
      worktreesDir,
      "local-scheduled-automations-v1",
      AUTOMATION_KEY,
      OCCURRENCE_KEY,
    );
    yield* fileSystem.makeDirectory(projectRoot, { recursive: true });
    const git = (args: ReadonlyArray<string>) =>
      driver.execute({ operation: "automation-pruner.integration", cwd: projectRoot, args });
    yield* git(["init", "--initial-branch=main"]);
    yield* git(["config", "user.email", "test@example.com"]);
    yield* git(["config", "user.name", "Test User"]);
    yield* fileSystem.writeFileString(path.join(projectRoot, "README.md"), "integration\n");
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "initial"]);
    yield* driver.createWorktree({
      cwd: projectRoot,
      refName: "main",
      newRefName: BRANCH,
      path: candidatePath,
    });
    const trackedIdentity = dirtyIdentity("integration-tracked");
    const untrackedIdentity = dirtyIdentity("integration-untracked");
    const trackedPath = path.join(
      worktreesDir,
      "local-scheduled-automations-v1",
      trackedIdentity.automationKey,
      OCCURRENCE_KEY,
    );
    const untrackedPath = path.join(
      worktreesDir,
      "local-scheduled-automations-v1",
      untrackedIdentity.automationKey,
      OCCURRENCE_KEY,
    );
    yield* driver.createWorktree({
      cwd: projectRoot,
      refName: "main",
      newRefName: trackedIdentity.branch,
      path: trackedPath,
    });
    yield* driver.createWorktree({
      cwd: projectRoot,
      refName: "main",
      newRefName: untrackedIdentity.branch,
      path: untrackedPath,
    });
    yield* fileSystem.writeFileString(path.join(trackedPath, "README.md"), "tracked change\n");
    yield* fileSystem.writeFileString(path.join(untrackedPath, "untracked.txt"), "untracked\n");

    const projectId = ProjectId.make("project-1");
    const activities: Array<OrchestrationThread["activities"][number]> = [
      {
        id: EventId.make("initial-activity"),
        tone: "info",
        kind: "task.completed",
        summary: "Automation completed.",
        payload: {},
        turnId: TurnId.make("turn-1"),
        createdAt: OLD,
      },
    ];
    const thread: OrchestrationThread = {
      id: THREAD_ID,
      projectId,
      title: "Automation: integration nightly",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: BRANCH,
      worktreePath: candidatePath,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: OLD,
        startedAt: OLD,
        completedAt: OLD,
        assistantMessageId: null,
      },
      createdAt: OLD,
      updatedAt: OLD,
      archivedAt: null,
      settledOverride: "active",
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      titleRegeneration: null,
      deletedAt: null,
      messages: [
        {
          id: MessageId.make("message-1"),
          role: "user",
          text: "Run the integration automation.",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: OLD,
          updatedAt: OLD,
        },
      ],
      proposedPlans: [],
      activities,
      checkpoints: [],
      session: null,
    };
    const project: OrchestrationProject = {
      id: projectId,
      title: "Project",
      workspaceRoot: projectRoot,
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: OLD,
      updatedAt: OLD,
      deletedAt: null,
    };
    const shell: OrchestrationThreadShell = {
      id: thread.id,
      projectId,
      title: thread.title,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      latestTurn: thread.latestTurn,
      createdAt: OLD,
      updatedAt: OLD,
      archivedAt: null,
      settledOverride: "active",
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      titleRegeneration: null,
      session: null,
      latestUserMessageAt: OLD,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    };
    const trackedShell: OrchestrationThreadShell = {
      ...shell,
      id: trackedIdentity.threadId,
      branch: trackedIdentity.branch,
      worktreePath: trackedPath,
    };
    const untrackedShell: OrchestrationThreadShell = {
      ...shell,
      id: untrackedIdentity.threadId,
      branch: untrackedIdentity.branch,
      worktreePath: untrackedPath,
    };
    const shellSnapshot: OrchestrationShellSnapshot = {
      snapshotSequence: 1,
      projects: [project],
      threads: [shell, trackedShell, untrackedShell],
      updatedAt: OLD,
    };

    const activitiesByThread = new Map([
      [thread.id, activities],
      [trackedShell.id, [] as typeof activities],
      [untrackedShell.id, [] as typeof activities],
    ]);
    const commands: Array<OrchestrationCommand> = [];
    const pruner = yield* makeScheduledAutomationWorktreePruner().pipe(
      Effect.provideService(ServerConfig, { worktreesDir } as ServerConfig["Service"]),
      Effect.provideService(ServerSettingsService, {
        getSettings: Effect.succeed({
          localScheduledAutomationWorktreeRetentionDays: 7,
        } as ServerSettings),
      } as unknown as ServerSettingsService["Service"]),
      Effect.provideService(ProjectionSnapshotQuery, {
        getShellSnapshot: () => Effect.succeed(shellSnapshot),
        getArchivedShellSnapshot: () => Effect.succeed({ ...shellSnapshot, threads: [] }),
        getRetainedThreadShellById: (threadId: ThreadId) =>
          Effect.succeed(
            Option.fromNullishOr(
              [shell, trackedShell, untrackedShell].find((candidate) => candidate.id === threadId),
            ),
          ),
        getProjectShellById: () => Effect.succeed(Option.some(project)),
      } as unknown as ProjectionSnapshotQuery["Service"]),
      Effect.provideService(ProjectionThreadActivityRepository, {
        listByThreadId: ({ threadId }: { readonly threadId: ThreadId }) =>
          Effect.succeed(
            (activitiesByThread.get(threadId) ?? []).map((activity) => ({
              activityId: activity.id,
              threadId,
              turnId: activity.turnId,
              tone: activity.tone,
              kind: activity.kind,
              summary: activity.summary,
              payload: activity.payload,
              ...(activity.sequence === undefined ? {} : { sequence: activity.sequence }),
              createdAt: activity.createdAt,
            })),
          ),
      } as unknown as ProjectionThreadActivityRepository["Service"]),
      Effect.provideService(OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            commands.push(command);
            if (command.type === "thread.activity.append") {
              activitiesByThread.get(command.threadId)?.push(command.activity);
            }
            return { sequence: commands.length };
          }),
      } as unknown as OrchestrationEngineService["Service"]),
      Effect.provideService(GitWorkflowService, {
        listRefs: driver.listRefs,
        invalidateLocalStatus: () => Effect.void,
        localStatus: driver.status,
        removeWorktree: driver.removeWorktree,
      } as unknown as GitWorkflowService["Service"]),
    );

    expect(parseScheduledAutomationThreadIdentity(THREAD_ID)).not.toBeNull();
    const summary = yield* pruner.runOnce;
    expect({ summary, activities }).toMatchObject({
      summary: { candidates: 3, pruned: 1, blocked: 2, deferred: 0 },
    });
    expect(yield* fileSystem.exists(candidatePath)).toBe(false);
    const refs = yield* driver.listRefs({
      cwd: projectRoot,
      query: BRANCH,
      refresh: true,
      limit: 100,
    });
    const retainedBranch = refs.refs.find((ref) => ref.name === BRANCH);
    assert(retainedBranch !== undefined);
    expect(retainedBranch.worktreePath).toBeNull();
    expect(thread.worktreePath).toBe(candidatePath);
    expect(thread.messages).toHaveLength(1);
    expect(activities.some((activity) => activity.id === EventId.make("initial-activity"))).toBe(
      true,
    );
    expect(
      activities.some((activity) => activity.kind === "local-scheduled-automation.worktree.pruned"),
    ).toBe(true);
    expect(yield* fileSystem.exists(trackedPath)).toBe(true);
    expect(yield* fileSystem.exists(untrackedPath)).toBe(true);
    expect(commands).toHaveLength(3);
    expect(commands.every((command) => command.type === "thread.activity.append")).toBe(true);
    for (const dirtyThreadId of [trackedShell.id, untrackedShell.id]) {
      expect(
        activitiesByThread
          .get(dirtyThreadId)
          ?.some(
            (activity) =>
              activity.kind === "local-scheduled-automation.worktree.prune-blocked" &&
              (activity.payload as { readonly reason?: string }).reason === "dirty-worktree",
          ),
      ).toBe(true);
    }
  }).pipe(Effect.provide(DriverLayer)),
);
