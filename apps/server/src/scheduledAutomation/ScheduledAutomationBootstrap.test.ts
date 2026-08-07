import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  OrchestrationProjectShell,
  OrchestrationDispatchCommandError,
  ScheduledAutomation,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { expect, it, vi } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  makeThreadBootstrapService,
  ThreadBootstrapService,
} from "../orchestration/Services/ThreadBootstrapService.ts";
import * as WorkspaceMutationCoordinator from "../orchestration/Services/WorkspaceMutationCoordinator.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { makeScheduledAutomationBootstrap } from "./ScheduledAutomationBootstrap.ts";

const project = Schema.decodeUnknownSync(OrchestrationProjectShell)({
  id: "project-1",
  title: "Project",
  workspaceRoot: "/workspace/project-1",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
});

const automation = Schema.decodeUnknownSync(ScheduledAutomation)({
  id: "nightly-maintenance",
  revision: 2,
  name: "Nightly maintenance",
  prompt: "Inspect the workspace.",
  projectId: "project-1",
  modelSelection: { instanceId: "codex", model: "gpt-5.6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  worktreePolicy: { kind: "new-worktree", baseBranch: "main", startFromOrigin: true },
  setupScriptPolicy: "skip",
  schedule: { cron: "30 2 * * *", timeZone: "UTC", misfirePolicy: "latest-only" },
  enabled: true,
  enabledAt: "2026-08-01T00:00:00.000Z",
  lastScheduledFor: null,
  lastThreadId: null,
  lastOutcome: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
});

it.effect("builds deterministic automation bootstrap input and always skips setup scripts", () =>
  Effect.gen(function* () {
    const dispatched: Array<Extract<OrchestrationCommand, { type: "thread.turn.start" }>> = [];
    const bootstrapInputs: Array<Extract<OrchestrationCommand, { type: "thread.turn.start" }>> = [];
    const runForThread = vi.fn(() => Effect.die("automation setup scripts must stay disabled"));
    let thread: OrchestrationThread | null = null;
    let sequence = 0;
    const bootstrapService = yield* makeThreadBootstrapService.pipe(
      Effect.provide(WorkspaceMutationCoordinator.layer),
      Effect.provideService(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
      Effect.provideService(OrchestrationCommandReceiptRepository, {
        getByCommandId: () => Effect.succeed(Option.none()),
      } as unknown as OrchestrationCommandReceiptRepository["Service"]),
      Effect.provideService(ProjectionSnapshotQuery, {
        getThreadDetailById: () => Effect.sync(() => Option.fromNullishOr(thread)),
      } as unknown as ProjectionSnapshotQuery["Service"]),
      Effect.provideService(OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            sequence += 1;
            if (command.type === "thread.create") {
              thread = {
                id: command.threadId,
                projectId: command.projectId,
                title: command.title,
                modelSelection: command.modelSelection,
                runtimeMode: command.runtimeMode,
                interactionMode: command.interactionMode,
                branch: command.branch,
                worktreePath: command.worktreePath,
                latestTurn: null,
                createdAt: command.createdAt,
                updatedAt: command.createdAt,
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
            } else if (command.type === "thread.meta.update" && thread !== null) {
              thread = {
                ...thread,
                branch: command.branch ?? thread.branch,
                worktreePath: command.worktreePath ?? thread.worktreePath,
              };
            } else if (command.type === "thread.turn.start") {
              dispatched.push(command);
            }
            return { sequence };
          }),
      } as unknown as OrchestrationEngineService["Service"]),
      Effect.provideService(GitWorkflowService.GitWorkflowService, {
        listRefs: () =>
          Effect.succeed({
            refs: [],
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 0,
          }),
        fetchRemote: () => Effect.void,
        resolveRemoteTrackingCommit: () => Effect.succeed({ commitSha: "abc123" }),
        createWorktree: (input: { readonly newRefName?: string; readonly path: string | null }) =>
          Effect.succeed({
            worktree: { path: input.path!, refName: input.newRefName! },
          }),
      } as unknown as GitWorkflowService.GitWorkflowService["Service"]),
      Effect.provideService(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
        runForThread,
      } as unknown as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]),
      Effect.provideService(VcsStatusBroadcaster.VcsStatusBroadcaster, {
        refreshStatus: () => Effect.succeed({}),
      } as unknown as VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]),
    );
    const service = yield* makeScheduledAutomationBootstrap.pipe(
      Effect.provideService(ServerConfig, {
        worktreesDir: "/tmp/t3-worktrees",
      } as ServerConfig["Service"]),
      Effect.provideService(ProjectionSnapshotQuery, {
        getProjectShellById: () => Effect.succeed(Option.some(project)),
      } as unknown as ProjectionSnapshotQuery["Service"]),
      Effect.provideService(
        ThreadBootstrapService,
        ThreadBootstrapService.of({
          dispatch: (command) =>
            Effect.sync(() => bootstrapInputs.push(command)).pipe(
              Effect.flatMap(() => bootstrapService.dispatch(command)),
            ),
        }),
      ),
    );

    const result = yield* service.dispatch(automation, "2026-08-03T02:30:00.000Z");

    expect(result).toEqual({ sequence: 3 });
    expect(runForThread).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(1);
    expect(bootstrapInputs).toHaveLength(1);
    expect(bootstrapInputs[0]).toMatchObject({
      commandId: expect.stringContaining(":command:bootstrap"),
      message: { text: "Inspect the workspace.", attachments: [] },
      bootstrap: {
        createThread: { title: "Automation: Nightly maintenance" },
        runSetupScript: false,
        reconcileThreadRevision: 2,
        prepareWorktree: {
          projectCwd: "/workspace/project-1",
          baseBranch: "main",
          startFromOrigin: true,
          branch: expect.stringContaining("t3/local-scheduled-automation/"),
          targetPath: expect.stringContaining("/local-scheduled-automations-v1/"),
        },
      },
    });
    expect(bootstrapInputs[0]).not.toHaveProperty("titleSeed");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("classifies otherwise-untyped bootstrap failures as retryable", () =>
  Effect.gen(function* () {
    const service = yield* makeScheduledAutomationBootstrap.pipe(
      Effect.provideService(ServerConfig, {
        worktreesDir: "/tmp/t3-worktrees",
      } as ServerConfig["Service"]),
      Effect.provideService(ProjectionSnapshotQuery, {
        getProjectShellById: () => Effect.succeed(Option.some(project)),
      } as unknown as ProjectionSnapshotQuery["Service"]),
      Effect.provideService(
        ThreadBootstrapService,
        ThreadBootstrapService.of({
          dispatch: () =>
            Effect.fail(
              new OrchestrationDispatchCommandError({ message: "Temporary Git failure." }),
            ),
        }),
      ),
    );

    const error = yield* service.dispatch(automation, "2026-08-03T02:30:00.000Z").pipe(Effect.flip);

    expect(error).toMatchObject({
      code: "bootstrap.retryable",
      retryable: true,
      message: "Temporary Git failure.",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("classifies every adapter-owned failure disposition", () =>
  Effect.gen(function* () {
    let projectMode: "query-failure" | "missing" | "present" = "query-failure";
    let bootstrapError = new OrchestrationDispatchCommandError({
      code: "bootstrap.phase-state-conflict",
      retryable: false,
      message: "Receipt and projection disagree.",
    });
    const service = yield* makeScheduledAutomationBootstrap.pipe(
      Effect.provideService(ServerConfig, {
        worktreesDir: "/tmp/t3-worktrees",
      } as ServerConfig["Service"]),
      Effect.provideService(ProjectionSnapshotQuery, {
        getProjectShellById: () =>
          projectMode === "query-failure"
            ? Effect.fail({ _tag: "FixtureProjectQueryError" as const })
            : Effect.succeed(projectMode === "missing" ? Option.none() : Option.some(project)),
      } as unknown as ProjectionSnapshotQuery["Service"]),
      Effect.provideService(
        ThreadBootstrapService,
        ThreadBootstrapService.of({ dispatch: () => Effect.fail(bootstrapError) }),
      ),
    );

    expect(
      yield* service.dispatch(automation, "2026-08-03T02:30:00.000Z").pipe(Effect.flip),
    ).toMatchObject({ code: "automation.project-query-failed", retryable: true });
    projectMode = "missing";
    expect(
      yield* service.dispatch(automation, "2026-08-03T02:30:00.000Z").pipe(Effect.flip),
    ).toMatchObject({ code: "automation.project-unavailable", retryable: true });
    projectMode = "present";
    expect(yield* service.dispatch(automation, "not-absolute").pipe(Effect.flip)).toMatchObject({
      code: "automation.identity-invalid",
      retryable: false,
    });
    expect(yield* service.dispatch(automation, "2026-08-03T02:30:00.000Z").pipe(Effect.flip)).toBe(
      bootstrapError,
    );

    bootstrapError = new OrchestrationDispatchCommandError({
      message: "Temporary Git failure.",
    });
    expect(
      yield* service.dispatch(automation, "2026-08-03T02:30:00.000Z").pipe(Effect.flip),
    ).toMatchObject({ code: "bootstrap.retryable", retryable: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("classifies an escaped owned worktree path as non-retryable", () =>
  Effect.gen(function* () {
    const nodePath = yield* Path.Path;
    const service = yield* makeScheduledAutomationBootstrap.pipe(
      Effect.provideService(ServerConfig, {
        worktreesDir: "/tmp/t3-worktrees",
      } as ServerConfig["Service"]),
      Effect.provideService(ProjectionSnapshotQuery, {
        getProjectShellById: () => Effect.succeed(Option.some(project)),
      } as unknown as ProjectionSnapshotQuery["Service"]),
      Effect.provideService(
        ThreadBootstrapService,
        ThreadBootstrapService.of({ dispatch: () => Effect.die("must fail before dispatch") }),
      ),
      Effect.provideService(Path.Path, {
        ...nodePath,
        resolve: (...segments: ReadonlyArray<string>) =>
          segments.length === 2 ? "/owned/root" : "/escaped/occurrence",
      }),
    );

    expect(
      yield* service.dispatch(automation, "2026-08-03T02:30:00.000Z").pipe(Effect.flip),
    ).toMatchObject({ code: "automation.worktree-path-escape", retryable: false });
  }).pipe(Effect.provide(NodeServices.layer)),
);
