import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ClientOrchestrationCommand,
  type OrchestrationShellSnapshot,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  IngressFailure,
  startStandardIngress,
  T3TransportError,
  type T3Transport,
} from "@t3tools/integration-runtime";
import * as Effect from "effect/Effect";

import { handleMentionEvent, handleSlashCommand, promptValidationMessage } from "./app.ts";

it("rejects empty and oversized custom prompts before Block Kit rendering", () => {
  expect(promptValidationMessage("   ")).toContain("Include a prompt");
  expect(promptValidationMessage("x".repeat(3_001))).toContain("3,000");
  expect(promptValidationMessage("valid prompt")).toBeNull();
});

describe("Slack slash handler", () => {
  it("passes a Slack payload through the runtime to deterministic commands and a deep link", async () => {
    const projectId = ProjectId.make("project-main");
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    };
    const commands: Array<ClientOrchestrationCommand> = [];
    const transport: T3Transport = {
      validateSession: () => Effect.die("not used"),
      getThreadSnapshot: () => Effect.succeed(null),
      getShellSnapshot: () =>
        Effect.succeed({
          projects: [
            {
              id: projectId,
              workspaceRoot: "/workspace/t3code",
              defaultModelSelection: modelSelection,
            },
          ],
        } as unknown as OrchestrationShellSnapshot),
      getServerConfig: () =>
        Effect.succeed({
          environment: { environmentId: EnvironmentId.make("environment-main") },
          providers: [
            {
              instanceId: modelSelection.instanceId,
              enabled: true,
              installed: true,
              availability: "available",
              status: "ready",
              auth: { status: "authenticated" },
              models: [{ slug: modelSelection.model }],
            },
          ],
        } as unknown as ServerConfig),
      dispatch: (command) => {
        commands.push(command);
        return Effect.succeed({ sequence: commands.length });
      },
      listRefs: () => Effect.die("not used"),
      switchRef: () => Effect.die("not used"),
      dispatchBootstrap: () => Effect.die("not used"),
    };
    const responses: Array<string> = [];

    await handleSlashCommand({
      teamId: "T123",
      responseUrl: "https://hooks.slack.com/commands/T123/456/stable-secret",
      text: "inspect CI",
      publicBaseUrl: "https://t3.example",
      ack: async () => undefined,
      start: (invocation) =>
        // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Slack's async callback boundary requires a Promise.
        Effect.runPromise(
          startStandardIngress({
            request: {
              invocation,
              target: { projectId, modelSelection: null },
              requestedAt: "2026-07-31T10:00:00.000Z",
            },
            publicBaseUrl: "https://t3.example",
            transport,
          }),
        ),
      respond: async (message) => {
        responses.push(message.text);
      },
    });

    expect(commands.map((command) => command.type)).toEqual(["thread.create", "thread.turn.start"]);
    expect(commands[0]).toMatchObject({ branch: null, worktreePath: null });
    expect(commands[1]).toMatchObject({ message: { text: "inspect CI" } });
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatch(
      /^Open in T3 Code: https:\/\/t3\.example\/environment-main\/t3i%3Av1%3Aslack%3Aslash%3A.+%3Athread$/,
    );
  });

  it("acknowledges before starting T3 work", async () => {
    const calls: Array<string> = [];
    await handleSlashCommand({
      teamId: "T123",
      responseUrl: "https://hooks.slack.com/commands/T123/456/secret",
      text: "inspect CI",
      publicBaseUrl: "https://t3.example",
      ack: async () => {
        calls.push("ack");
      },
      start: async () => {
        calls.push("start");
        return { recovery: "created", deepLink: "https://t3.example/env/thread" };
      },
      respond: async () => {
        calls.push("respond");
      },
    });
    expect(calls).toEqual(["ack", "start", "respond"]);
  });

  it("rejects an empty prompt without starting", async () => {
    const calls: Array<string> = [];
    await handleSlashCommand({
      teamId: "T123",
      responseUrl: "https://hooks.slack.com/commands/T123/456/secret",
      text: "  ",
      publicBaseUrl: "https://t3.example",
      ack: async () => {
        calls.push("ack");
      },
      start: async () => {
        calls.push("start");
        return { recovery: "created", deepLink: "https://t3.example" };
      },
      respond: async (message) => {
        calls.push(message.text);
      },
    });
    expect(calls).toEqual(["ack", "Usage: /t3 <prompt>"]);
  });

  it("renders an unverified result with the public base URL", async () => {
    const responses: Array<string> = [];
    await handleSlashCommand({
      teamId: "T123",
      responseUrl: "https://hooks.slack.com/commands/T123/456/secret",
      text: "inspect CI",
      publicBaseUrl: "https://t3.example",
      ack: async () => undefined,
      start: async () => ({ recovery: "unverified", deepLink: "https://t3.example" }),
      respond: async (message) => {
        responses.push(message.text);
      },
    });
    expect(responses).toEqual([
      "T3 Code could not verify whether the conversation started. Open https://t3.example",
    ]);
  });

  it("renders a safe T3 failure", async () => {
    const responses: Array<string> = [];
    await handleSlashCommand({
      teamId: "T123",
      responseUrl: "https://hooks.slack.com/commands/T123/456/secret",
      text: "inspect CI",
      publicBaseUrl: "https://t3.example",
      ack: async () => undefined,
      start: async () => {
        throw new T3TransportError("authorization", "private detail", null);
      },
      respond: async (message) => {
        responses.push(message.text);
      },
    });
    expect(responses).toEqual([
      "T3 Code is not authorized. Ask an administrator to check the integration credential.",
    ]);
  });

  it("allows a recoverable standard failure to render Configure controls", async () => {
    const responses: Array<{ readonly text: string; readonly blocks?: ReadonlyArray<object> }> = [];
    await handleSlashCommand({
      teamId: "T123",
      responseUrl: "https://hooks.slack.com/commands/T123/456/secret",
      text: "inspect CI",
      publicBaseUrl: "https://t3.example",
      ack: async () => undefined,
      start: async () => {
        throw new IngressFailure("model_unavailable", "No default model is available.");
      },
      failureMessage: () => ({ text: "Configure instead", blocks: [{ type: "actions" }] }),
      respond: async (message) => {
        responses.push(message);
      },
    });
    expect(responses).toEqual([
      expect.objectContaining({ text: "Configure instead", blocks: [{ type: "actions" }] }),
    ]);
  });

  it("does not reinterpret a Slack success-delivery error as a T3 failure", async () => {
    let responseAttempts = 0;
    await expect(
      handleSlashCommand({
        teamId: "T123",
        responseUrl: "https://hooks.slack.com/commands/T123/456/secret",
        text: "inspect CI",
        publicBaseUrl: "https://t3.example",
        ack: async () => undefined,
        start: async () => ({
          recovery: "created",
          deepLink: "https://t3.example/environment-main/thread-main",
        }),
        respond: async () => {
          responseAttempts += 1;
          throw new Error("Slack delivery failed");
        },
      }),
    ).rejects.toThrow("Slack delivery failed");
    expect(responseAttempts).toBe(1);
  });
});

describe("Slack mention handler", () => {
  it("posts and updates one threaded starting message with deterministic ID-only metadata", async () => {
    const posted: Array<object> = [];
    const updated: Array<object> = [];
    let normalizedPrompt = "";
    await handleMentionEvent({
      teamId: "T123",
      channelId: "C123",
      botUserId: "U_T3",
      eventId: "Ev123",
      messageTimestamp: "171.002",
      parentThreadTimestamp: "170.001",
      text: "<@U_T3> ask <@U456> to inspect CI",
      publicBaseUrl: "https://t3.example",
      postMessage: async (message) => {
        posted.push(message);
        return { ts: "172.003" };
      },
      updateMessage: async (message) => {
        updated.push(message);
      },
      warn: () => undefined,
      start: async (invocation) => {
        normalizedPrompt = invocation.prompt;
        return {
          recovery: "created",
          deepLink: "https://t3.example/environment-main/thread-main",
        };
      },
    });

    expect(normalizedPrompt).toBe("ask <@U456> to inspect CI");
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      thread_ts: "170.001",
      text: "Starting in T3 Code...",
      metadata: {
        event_type: "t3_ingress_v1",
        event_payload: {
          thread_id: expect.stringContaining("t3i:v1:slack:mention:"),
          message_id: expect.stringContaining(":message:initial"),
        },
      },
    });
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      ts: "172.003",
      text: "Open in T3 Code: https://t3.example/environment-main/thread-main",
      metadata: (posted[0] as { metadata: object }).metadata,
    });
    expect(
      Object.keys((posted[0] as { metadata: { event_payload: object } }).metadata.event_payload),
    ).toEqual(["thread_id", "message_id"]);
  });

  it("does not overwrite a successful T3 result after a Slack update error", async () => {
    let updateAttempts = 0;
    await expect(
      handleMentionEvent({
        teamId: "T123",
        channelId: "C123",
        botUserId: "U_T3",
        eventId: "Ev123",
        messageTimestamp: "171.002",
        text: "<@U_T3> inspect CI",
        publicBaseUrl: "https://t3.example",
        postMessage: async () => ({ ts: "172.003" }),
        updateMessage: async () => {
          updateAttempts += 1;
          throw new Error("Slack update failed");
        },
        warn: () => undefined,
        start: async () => ({
          recovery: "created",
          deepLink: "https://t3.example/environment-main/thread-main",
        }),
      }),
    ).rejects.toThrow("Slack update failed");
    expect(updateAttempts).toBe(1);
  });

  it("allows a recoverable mention failure to replace Starting with Configure controls", async () => {
    const updates: Array<object> = [];
    await handleMentionEvent({
      teamId: "T123",
      channelId: "C123",
      botUserId: "U_T3",
      eventId: "Ev123",
      messageTimestamp: "171.002",
      text: "<@U_T3> inspect CI",
      publicBaseUrl: "https://t3.example",
      postMessage: async () => ({ ts: "172.003" }),
      updateMessage: async (message) => updates.push(message),
      warn: () => undefined,
      start: async () => {
        throw new IngressFailure("model_unavailable", "No default model is available.");
      },
      failureMessage: () => ({ text: "Configure instead", blocks: [{ type: "actions" }] }),
    });
    expect(updates).toEqual([
      expect.objectContaining({ text: "Configure instead", blocks: [{ type: "actions" }] }),
    ]);
  });
});
