import { ProjectId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveOpenWalkthroughTarget } from "./openWalkthrough.logic";

function link(
  number: number,
  state: "open" | "merged",
  source: ThreadPullRequestLink["source"] = "manual",
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "acme/web",
    number,
    url: `https://github.com/acme/web/pull/${number}`,
    source,
    linkedAt: "2026-01-01T00:00:00.000Z",
    snapshot: {
      state,
      title: `PR ${number}`,
      headBranch: `branch-${number}`,
      baseBranch: "main",
      isDraft: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
      syncedAt: "2026-01-01T00:00:00.000Z",
    },
    stack: null,
  };
}

const legacy = (number: number) => ({
  projectId: ProjectId.make("project"),
  repository: "acme/web",
  number,
  url: `https://github.com/acme/web/pull/${number}`,
});

describe("resolveOpenWalkthroughTarget", () => {
  it("opens the pull request the thread details row shows", () => {
    expect(
      resolveOpenWalkthroughTarget({
        pullRequests: [link(1, "merged"), link(2, "open")],
        linkedPullRequest: legacy(7),
        branchPullRequest: legacy(8),
      }),
    ).toEqual({ kind: "pull-request", url: "https://github.com/acme/web/pull/2" });
  });

  it("falls back to the legacy link, then the branch's pull request", () => {
    expect(
      resolveOpenWalkthroughTarget({ linkedPullRequest: legacy(7), branchPullRequest: legacy(8) }),
    ).toEqual({ kind: "pull-request", url: "https://github.com/acme/web/pull/7" });
    expect(
      resolveOpenWalkthroughTarget({ pullRequests: [], branchPullRequest: legacy(8) }),
    ).toEqual({ kind: "pull-request", url: "https://github.com/acme/web/pull/8" });
  });

  it("walks the thread's own diff without a pull request", () => {
    expect(
      resolveOpenWalkthroughTarget({
        pullRequests: [link(3, "open", "stack-dismissed")],
        linkedPullRequest: null,
        branchPullRequest: null,
      }),
    ).toEqual({ kind: "thread-diff" });
    expect(resolveOpenWalkthroughTarget({})).toEqual({ kind: "thread-diff" });
  });
});
