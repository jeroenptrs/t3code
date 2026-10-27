import { vi, describe, expect, it } from "vite-plus/test";

vi.mock("expo-device", () => ({ osVersion: "26.1", modelName: "Apple TV 4K" }));

import { authClientMetadata } from "./authClientMetadata";

describe("authClientMetadata", () => {
  it("sends device type unknown, which servers before the TV client accept, and surface tv", () => {
    const metadata = authClientMetadata("1.2.3");
    expect(metadata.deviceType).toBe("unknown");
    expect(metadata.surface).toBe("tv");
    expect(metadata).toMatchObject({ os: "tvOS", osMajorVersion: 26, appVersion: "1.2.3" });
  });
});
