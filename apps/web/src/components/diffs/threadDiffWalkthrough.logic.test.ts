import { describe, expect, it } from "vite-plus/test";

import { buildThreadDiffWalkthroughPrompt } from "./threadDiffWalkthrough.logic";

describe("buildThreadDiffWalkthroughPrompt", () => {
  it("points both tools at the turn's checkpoint range", () => {
    const prompt = buildThreadDiffWalkthroughPrompt({ fromTurnCount: 2, toTurnCount: 3 });
    expect(prompt).toContain("turn 3's changes");
    expect(prompt).toContain("`read_thread_diff` (fromTurnCount 2, toTurnCount 3)");
    expect(prompt).toContain(
      "`write_diff_walkthrough` with target kind `thread-diff`, fromTurnCount 2 and toTurnCount 3",
    );
    expect(prompt).toContain("Do not change any code.");
  });

  it("names a range wider than one turn by its ends", () => {
    const prompt = buildThreadDiffWalkthroughPrompt({ fromTurnCount: 0, toTurnCount: 4 });
    expect(prompt).toContain("the changes of turns 1 to 4");
    expect(prompt).toContain("(fromTurnCount 0, toTurnCount 4)");
  });
});
