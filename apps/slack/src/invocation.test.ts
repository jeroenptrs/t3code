import { describe, expect, it } from "@effect/vitest";

import {
  isCustomMentionPrompt,
  normalizeCustomMentionInvocation,
  normalizeDirectMessageInvocation,
  normalizeMentionInvocation,
  normalizeSlashInvocation,
} from "./invocation.ts";

describe("Slack invocation normalization", () => {
  it("requires a custom mention boundary", () => {
    expect(isCustomMentionPrompt("custom: configure this")).toBe(true);
    expect(isCustomMentionPrompt("custom : configure this")).toBe(true);
    expect(isCustomMentionPrompt("custom configure this")).toBe(true);
    expect(isCustomMentionPrompt("customize the CI form")).toBe(false);
  });
  it("uses a secret-safe digest of the slash response URL", () => {
    const invocation = normalizeSlashInvocation({
      teamId: "T123",
      responseUrl: "https://hooks.slack.com/commands/T123/456/secret",
      text: "  inspect CI  ",
    });
    expect(invocation.prompt).toBe("inspect CI");
    expect(invocation.invocationId).not.toContain("secret");
    expect(invocation).toEqual(
      normalizeSlashInvocation({
        teamId: "T123",
        responseUrl: "https://hooks.slack.com/commands/T123/456/secret",
        text: "inspect CI",
      }),
    );
  });

  it("uses the mention event ID rather than its parent thread", () => {
    const invocation = normalizeMentionInvocation({
      teamId: "T123",
      channelId: "C123",
      botUserId: "U123",
      eventId: "Ev123",
      messageTimestamp: "171.002",
      text: "<@U123|t3> ask <@U456> to inspect CI",
    });
    expect(invocation.invocationId).toBe("Ev123");
    expect(invocation.prompt).toBe("ask <@U456> to inspect CI");
  });

  it("falls back to the mention message timestamp", () => {
    expect(
      normalizeMentionInvocation({
        teamId: "T123",
        channelId: "C123",
        botUserId: "U123",
        messageTimestamp: "171.002",
        text: "<@U123> inspect CI",
      }).invocationId,
    ).toBe("C123:171.002");
  });

  it("keys custom mentions from the mention while removing the custom syntax", () => {
    const invocation = normalizeCustomMentionInvocation({
      teamId: "T123",
      channelId: "C123",
      botUserId: "U123",
      eventId: "Ev-custom",
      messageTimestamp: "171.003",
      text: "<@U123> custom: inspect CI",
    });
    expect(invocation).toMatchObject({
      surface: "custom-mention",
      invocationId: "Ev-custom",
      prompt: "inspect CI",
    });
  });

  it("keys direct-message setup from the bot-owned root", () => {
    expect(
      normalizeDirectMessageInvocation({
        teamId: "T123",
        channelId: "D123",
        rootTimestamp: "171.004",
        text: " inspect CI ",
      }),
    ).toMatchObject({ surface: "dm", invocationId: "D123:171.004", prompt: "inspect CI" });
  });
});
