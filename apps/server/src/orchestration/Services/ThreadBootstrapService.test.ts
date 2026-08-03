import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import { OrchestrationEngineService } from "./OrchestrationEngine.ts";
import { makeThreadBootstrapService } from "./ThreadBootstrapService.ts";
import * as WorkspaceMutationCoordinator from "./WorkspaceMutationCoordinator.ts";

type BootstrapCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

const command: BootstrapCommand = {
  type: "thread.turn.start",
  commandId: CommandId.make("start"),
  threadId: ThreadId.make("thread"),
  message: {
    messageId: MessageId.make("message"),
    role: "user",
    text: "Implement it",
    attachments: [],
  },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  titleSeed: "Implement it",
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-08-01T00:00:00.000Z",
  bootstrap: {
    createThread: {
      projectId: ProjectId.make("project"),
      title: "Implement it",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    prepareWorktree: {
      projectCwd: "/repo",
      baseBranch: "main",
      branch: "t3code/12345678",
    },
    runSetupScript: true,
  },
};

describe("ThreadBootstrapService", () => {
  it.effect("preserves no-worktree bootstrap and applies the resolved switchRef branch", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const switched: Array<unknown> = [];
      const coordinator = yield* WorkspaceMutationCoordinator.make;
      const crypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) => Effect.succeed(data),
      });
      const service = yield* makeThreadBootstrapService.pipe(
        Effect.provideService(
          WorkspaceMutationCoordinator.WorkspaceMutationCoordinator,
          coordinator,
        ),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(OrchestrationEngineService, {
          dispatch: (next: OrchestrationCommand) => {
            dispatched.push(next);
            return (
              next.type === "thread.turn.start"
                ? coordinator.providerStartupSettled(next.threadId)
                : Effect.void
            ).pipe(Effect.as({ sequence: dispatched.length }));
          },
        } as unknown as OrchestrationEngineService["Service"]),
        Effect.provideService(GitWorkflowService.GitWorkflowService, {
          switchRef: (input: unknown) => {
            switched.push(input);
            return Effect.succeed({ refName: "resolved-feature" });
          },
        } as unknown as GitWorkflowService.GitWorkflowService["Service"]),
        Effect.provideService(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
          runForThread: () => Effect.die("not used"),
        } as unknown as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]),
        Effect.provideService(VcsStatusBroadcaster.VcsStatusBroadcaster, {
          refreshStatus: () => Effect.succeed({}),
        } as unknown as VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]),
      );
      const createThread = command.bootstrap!.createThread!;

      yield* service.dispatch({
        ...command,
        bootstrap: { createThread },
      });
      expect(dispatched.map((next) => next.type)).toEqual(["thread.create", "thread.turn.start"]);

      dispatched.length = 0;
      yield* service.dispatch({
        ...command,
        commandId: CommandId.make("start-switched"),
        threadId: ThreadId.make("thread-switched"),
        message: { ...command.message, messageId: MessageId.make("message-switched") },
        bootstrap: {
          switchRef: { cwd: "/repo", refName: "feature" },
          createThread,
        },
      });
      expect(switched).toEqual([{ cwd: "/repo", refName: "feature" }]);
      expect(dispatched[0]).toMatchObject({ type: "thread.create", branch: "resolved-feature" });
      expect(dispatched[1]).toMatchObject({ type: "thread.turn.start" });

      dispatched.length = 0;
      const targetPathError = yield* service
        .dispatch({
          ...command,
          bootstrap: {
            ...command.bootstrap,
            prepareWorktree: {
              ...command.bootstrap!.prepareWorktree!,
              targetPath: "/tmp/worktrees/deterministic",
            },
          },
        })
        .pipe(Effect.flip);
      expect(targetPathError).toMatchObject({
        _tag: "OrchestrationDispatchCommandError",
        message:
          "Explicit bootstrap worktree paths are not supported until deterministic bootstrap validation is enabled.",
      });
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("preserves create, worktree, setup activity, metadata, and final-start ordering", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const worktrees: Array<unknown> = [];
      const setupRuns: Array<unknown> = [];
      const refreshes: Array<string> = [];
      let reusableWorktreePath: string | null = null;
      const listRefCursors: Array<number | undefined> = [];
      const listRefQueries: Array<string | undefined> = [];
      let uuid = 0;
      const crypto = {
        ...Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
        randomUUIDv4: Effect.sync(
          () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
        ),
      };
      const service = yield* makeThreadBootstrapService.pipe(
        Effect.provide(WorkspaceMutationCoordinator.layer),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(OrchestrationEngineService, {
          dispatch: (next: OrchestrationCommand) => {
            dispatched.push(next);
            return Effect.succeed({ sequence: dispatched.length });
          },
        } as unknown as OrchestrationEngineService["Service"]),
        Effect.provideService(GitWorkflowService.GitWorkflowService, {
          listRefs: (input: { readonly cursor?: number; readonly query?: string }) => {
            listRefCursors.push(input.cursor);
            listRefQueries.push(input.query);
            return Effect.succeed({
              refs:
                reusableWorktreePath && input.cursor === 200
                  ? [
                      {
                        name: "t3code/12345678",
                        current: false,
                        isDefault: false,
                        worktreePath: reusableWorktreePath,
                      },
                    ]
                  : [],
              isRepo: true,
              hasPrimaryRemote: true,
              nextCursor: reusableWorktreePath && input.cursor === undefined ? 200 : null,
              totalCount: reusableWorktreePath ? 201 : 0,
            });
          },
          createWorktree: (input: unknown) => {
            worktrees.push(input);
            return Effect.succeed({
              worktree: { path: "/repo/.t3/worktrees/12345678", refName: "t3code/12345678" },
            });
          },
        } as unknown as GitWorkflowService.GitWorkflowService["Service"]),
        Effect.provideService(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
          runForThread: (input: unknown) => {
            setupRuns.push(input);
            return Effect.succeed({
              status: "started",
              scriptId: "setup",
              scriptName: "Setup",
              terminalId: "setup-terminal",
              cwd: "/repo/.t3/worktrees/12345678",
            });
          },
        } as unknown as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]),
        Effect.provideService(VcsStatusBroadcaster.VcsStatusBroadcaster, {
          refreshStatus: (cwd: string) => {
            refreshes.push(cwd);
            return Effect.succeed({});
          },
        } as unknown as VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]),
      );

      yield* service.dispatch(command);
      yield* Effect.yieldNow;

      expect(worktrees).toEqual([
        {
          cwd: "/repo",
          refName: "main",
          newRefName: "t3code/12345678",
          baseRefName: "main",
          path: null,
        },
      ]);
      expect(setupRuns).toEqual([
        {
          threadId: "thread",
          projectId: "project",
          projectCwd: "/repo",
          worktreePath: "/repo/.t3/worktrees/12345678",
        },
      ]);
      expect(refreshes).toEqual(["/repo/.t3/worktrees/12345678"]);
      expect(dispatched.map((next) => next.type)).toEqual([
        "thread.create",
        "thread.meta.update",
        "thread.activity.append",
        "thread.activity.append",
        "thread.turn.start",
      ]);
      expect(dispatched.at(-1)).not.toHaveProperty("bootstrap");

      reusableWorktreePath = "/repo/.t3/worktrees/12345678";
      yield* service.dispatch({
        ...command,
        commandId: CommandId.make("start-retry"),
        threadId: ThreadId.make("thread-retry"),
        message: { ...command.message, messageId: MessageId.make("message-retry") },
      });
      expect(worktrees).toHaveLength(1);
      expect(listRefCursors).toEqual([undefined, undefined, 200]);
      expect(listRefQueries).toEqual(["t3code/12345678", "t3code/12345678", "t3code/12345678"]);
      expect(dispatched).toContainEqual(
        expect.objectContaining({
          type: "thread.meta.update",
          threadId: "thread-retry",
          worktreePath: reusableWorktreePath,
        }),
      );

      reusableWorktreePath = "/repo/./";
      const conflict = yield* service
        .dispatch({
          ...command,
          commandId: CommandId.make("start-root-conflict"),
          threadId: ThreadId.make("thread-root-conflict"),
          message: { ...command.message, messageId: MessageId.make("message-root-conflict") },
        })
        .pipe(Effect.flip);
      expect(conflict.message).toContain("checked out in the project root");
      expect(worktrees).toHaveLength(1);
      expect(dispatched.slice(-2).map((next) => next.type)).toEqual([
        "thread.create",
        "thread.delete",
      ]);
    }),
  );
});
