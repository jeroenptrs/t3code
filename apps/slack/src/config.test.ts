import { describe, expect, it } from "@effect/vitest";

import { decodeSlackAppConfig } from "./config.ts";

const baseEnv = {
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_BOT_TOKEN: "xoxb-test",
  T3_HTTP_URL: "http://127.0.0.1:3000",
  T3_PUBLIC_URL: "https://t3.example",
  T3_BEARER_CREDENTIAL_FILE: "/run/secrets/t3-slack",
  T3_PROJECT_ID: "project-main",
};

describe("Slack app configuration", () => {
  it("decodes required values and defaults health to loopback", () => {
    expect(decodeSlackAppConfig(baseEnv)).toMatchObject({
      t3HttpBaseUrl: "http://127.0.0.1:3000/",
      t3PublicBaseUrl: "https://t3.example/",
      healthHost: "127.0.0.1",
      healthPort: 3210,
      credentialExpiryWarningDays: 10,
      modelSelection: null,
    });
    expect(
      decodeSlackAppConfig({ ...baseEnv, T3_CREDENTIAL_EXPIRY_WARNING_DAYS: "" })
        .credentialExpiryWarningDays,
    ).toBe(10);
  });

  it("decodes a complete integration model selection", () => {
    expect(
      decodeSlackAppConfig({
        ...baseEnv,
        T3_MODEL_SELECTION: JSON.stringify({
          instanceId: "codex",
          model: "gpt-5",
          options: [{ id: "reasoningEffort", value: "high" }],
        }),
      }).modelSelection,
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it("rejects missing values and invalid health ports", () => {
    expect(() => decodeSlackAppConfig({ ...baseEnv, SLACK_APP_TOKEN: "" })).toThrow(
      "SLACK_APP_TOKEN",
    );
    expect(() => decodeSlackAppConfig({ ...baseEnv, SLACK_HEALTH_PORT: "0" })).toThrow(
      "SLACK_HEALTH_PORT",
    );
    expect(() =>
      decodeSlackAppConfig({ ...baseEnv, T3_CREDENTIAL_EXPIRY_WARNING_DAYS: "0" }),
    ).toThrow("T3_CREDENTIAL_EXPIRY_WARNING_DAYS");
  });
});
