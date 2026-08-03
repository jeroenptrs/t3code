import { describe, expect, it, vi } from "@effect/vitest";
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { canonicalizeClientCommandTimestamps, normalizeDispatchCommand } from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";

describe("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });
});

describe("normalizeDispatchCommand", () => {
  it.effect("rejects an explicit target path before HTTP dispatch or attachment writes", () =>
    Effect.gen(function* () {
      const writeFile = vi.fn(() => Effect.void);
      const command: ClientOrchestrationCommand = {
        type: "thread.turn.start",
        commandId: CommandId.make("command-target-path"),
        threadId: ThreadId.make("thread-existing"),
        message: {
          messageId: MessageId.make("message-target-path"),
          role: "user",
          text: "Run in this exact path",
          attachments: [
            {
              type: "image",
              name: "pixel.png",
              mimeType: "image/png",
              sizeBytes: 68,
              dataUrl:
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            },
          ],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: {
          prepareWorktree: {
            projectCwd: "/repo",
            baseBranch: "main",
            targetPath: "/tmp/worktrees/deterministic",
          },
        },
        createdAt: clientCreatedAt,
      };

      const error = yield* normalizeDispatchCommand(command).pipe(
        Effect.provideService(FileSystem.FileSystem, { writeFile } as never),
        Effect.provideService(Path.Path, {} as never),
        Effect.provideService(ServerConfig, {} as never),
        Effect.provideService(WorkspacePaths.WorkspacePaths, {} as never),
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: "OrchestrationDispatchCommandError",
        message:
          "Explicit bootstrap worktree paths are not supported until deterministic bootstrap validation is enabled.",
      });
      expect(writeFile).not.toHaveBeenCalled();
    }),
  );
});
