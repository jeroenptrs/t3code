import { describe, expect, it } from "@effect/vitest";

import { normalizeMentionInvocation, normalizeSlashInvocation } from "./invocation.ts";

describe("Slack invocation normalization", () => {
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
});
