import { describe, expect, it } from "vite-plus/test";

import { diffWalkthroughPreferenceLines } from "./pullRequestWalkthroughPrompt.ts";

describe("diffWalkthroughPreferenceLines", () => {
  it("bounds long preferences and marks the cut", () => {
    const [preferences] = diffWalkthroughPreferenceLines("x".repeat(5_000));
    expect(preferences).toContain("x".repeat(4_000));
    expect(preferences).not.toContain("x".repeat(4_001));
    expect(preferences?.endsWith("[truncated]")).toBe(true);
  });
});
