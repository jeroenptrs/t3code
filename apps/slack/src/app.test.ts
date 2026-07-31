import { describe, expect, it } from "@effect/vitest";

import { handleSlashCommand } from "./app.ts";

describe("Slack slash handler", () => {
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
      ack: async (message) => {
        calls.push(message.text);
      },
      start: async () => {
        calls.push("start");
        return { recovery: "created", deepLink: "https://t3.example" };
      },
      respond: async () => {
        calls.push("respond");
      },
    });
    expect(calls).toEqual(["Usage: /t3 <prompt>"]);
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
});
