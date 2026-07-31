import { describe, expect, it } from "@effect/vitest";

import { deriveIngressIds, opaqueInvocationId } from "./identity.ts";
import { INGRESS_IDENTITY_VERSION, type IngressInvocation } from "./model.ts";

const slackInvocation = (surface: "slash" | "mention", invocationId: string) =>
  ({
    identityVersion: INGRESS_IDENTITY_VERSION,
    integration: "slack",
    tenantId: "T123ABC456",
    surface,
    invocationId,
    prompt: "Investigate the failing build",
  }) satisfies IngressInvocation;

describe("ingress identity", () => {
  it("derives versioned deterministic slash IDs without exposing the response URL", () => {
    const responseUrl =
      "https://hooks.slack.com/commands/T123ABC456/1234567890/secret-response-token";
    const invocationId = opaqueInvocationId(responseUrl);
    const ids = deriveIngressIds(slackInvocation("slash", invocationId));

    expect(ids).toMatchInlineSnapshot(`
      {
        "createCommandId": "t3i:v1:slack:slash:nM-Cx8h6zclSuMb098UDrY0kVw8Scl3kKH0XVK-vmeI:command:create",
        "messageId": "t3i:v1:slack:slash:nM-Cx8h6zclSuMb098UDrY0kVw8Scl3kKH0XVK-vmeI:message:initial",
        "startCommandId": "t3i:v1:slack:slash:nM-Cx8h6zclSuMb098UDrY0kVw8Scl3kKH0XVK-vmeI:command:start",
        "threadId": "t3i:v1:slack:slash:nM-Cx8h6zclSuMb098UDrY0kVw8Scl3kKH0XVK-vmeI:thread",
      }
    `);
    expect(JSON.stringify(ids)).not.toContain("secret-response-token");
  });

  it("derives distinct mention IDs from stable Events API event IDs", () => {
    const first = deriveIngressIds(slackInvocation("mention", "Ev01ABCDEF"));
    const retry = deriveIngressIds(slackInvocation("mention", "Ev01ABCDEF"));
    const next = deriveIngressIds(slackInvocation("mention", "Ev01ABCDEG"));

    expect(first).toEqual(retry);
    expect(first.threadId).not.toBe(next.threadId);
    expect(first).toMatchInlineSnapshot(`
      {
        "createCommandId": "t3i:v1:slack:mention:7ol1vYz3WSReeHIxrhA9bD4gg178kYbQJAcGbS-yONI:command:create",
        "messageId": "t3i:v1:slack:mention:7ol1vYz3WSReeHIxrhA9bD4gg178kYbQJAcGbS-yONI:message:initial",
        "startCommandId": "t3i:v1:slack:mention:7ol1vYz3WSReeHIxrhA9bD4gg178kYbQJAcGbS-yONI:command:start",
        "threadId": "t3i:v1:slack:mention:7ol1vYz3WSReeHIxrhA9bD4gg178kYbQJAcGbS-yONI:thread",
      }
    `);
  });

  it("includes tenant and surface in identity", () => {
    const slash = deriveIngressIds(slackInvocation("slash", "same"));
    const mention = deriveIngressIds(slackInvocation("mention", "same"));
    const otherTenant = deriveIngressIds({
      ...slackInvocation("slash", "same"),
      tenantId: "T999",
    });

    expect(slash.threadId).not.toBe(mention.threadId);
    expect(slash.threadId).not.toBe(otherTenant.threadId);
  });
});
