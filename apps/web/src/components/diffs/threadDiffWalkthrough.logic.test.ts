import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  branchRangeWalkthroughTarget,
  buildBranchRangeWalkthroughPrompt,
  buildThreadDiffWalkthroughPrompt,
} from "./threadDiffWalkthrough.logic";

describe("buildThreadDiffWalkthroughPrompt", () => {
  it("points both tools at the turn's checkpoint range", () => {
    const prompt = buildThreadDiffWalkthroughPrompt({ fromTurnCount: 2, toTurnCount: 3 });
    expect(prompt).toContain("turn 3's changes");
    expect(prompt).toContain(
      "`read_thread_diff` (target kind `thread-diff`, fromTurnCount 2, toTurnCount 3)",
    );
    expect(prompt).toContain(
      "`write_diff_walkthrough` with target kind `thread-diff`, fromTurnCount 2 and toTurnCount 3",
    );
    expect(prompt).toContain("Do not change any code.");
  });

  it("names a range wider than one turn by its ends", () => {
    const prompt = buildThreadDiffWalkthroughPrompt({ fromTurnCount: 0, toTurnCount: 4 });
    expect(prompt).toContain("the changes of turns 1 to 4");
    expect(prompt).toContain("fromTurnCount 0, toTurnCount 4)");
  });
});

describe("buildBranchRangeWalkthroughPrompt", () => {
  it("points both tools at the branch range and keeps uncommitted work out", () => {
    const prompt = buildBranchRangeWalkthroughPrompt("feature/walkthrough");
    expect(prompt).toContain("branch `feature/walkthrough`");
    expect(prompt).toContain("`read_thread_diff` (target kind `branch-range`)");
    expect(prompt).toContain("`write_diff_walkthrough` with target kind `branch-range`");
    expect(prompt).toContain("describe committed work only");
    expect(prompt).not.toContain("thread-diff");
  });
});

describe("branchRangeWalkthroughTarget", () => {
  const projectId = ProjectId.make("project-1");

  it("pins the branch to its merge base and HEAD", () => {
    expect(
      branchRangeWalkthroughTarget(projectId, {
        headRef: "feature/walkthrough",
        baseSha: "base",
        headSha: "head",
      }),
    ).toEqual({
      kind: "ready",
      target: {
        kind: "branch-range",
        projectId,
        branch: "feature/walkthrough",
        baseSha: "base",
        headSha: "head",
      },
    });
  });

  it("has no target on a detached HEAD", () => {
    for (const headRef of ["HEAD", null]) {
      expect(
        branchRangeWalkthroughTarget(projectId, { headRef, baseSha: "base", headSha: "head" }),
      ).toEqual({ kind: "unavailable", reason: "Walkthroughs need a branch. HEAD is detached." });
    }
  });

  it("has no target without both commits, as on an unborn HEAD or an older server", () => {
    for (const shas of [{}, { baseSha: "base" }, { headSha: "head" }]) {
      expect(branchRangeWalkthroughTarget(projectId, { headRef: "main", ...shas })).toEqual({
        kind: "unavailable",
        reason: "Walkthroughs need a branch with commits.",
      });
    }
  });
});
