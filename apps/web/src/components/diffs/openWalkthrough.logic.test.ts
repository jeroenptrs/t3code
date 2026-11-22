import { EnvironmentId, ProjectId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  readThreadWalkthroughLink,
  resolveOpenWalkthroughTarget,
  shownThreadWalkthroughLink,
  walkthroughShareUrl,
  withThreadWalkthroughLink,
} from "./openWalkthrough.logic";

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

describe("thread walkthrough links", () => {
  const prUrl = "https://github.com/acme/web/pull/2";

  it("round-trips a pull request's walkthrough and keeps other params", () => {
    const search = withThreadWalkthroughLink("?prompt=hi", { walkthrough: prUrl, expanded: true });
    expect(readThreadWalkthroughLink(search)).toEqual({ walkthrough: prUrl, expanded: true });
    expect(new URLSearchParams(search).get("prompt")).toBe("hi");
    expect(withThreadWalkthroughLink(search, null)).toBe("?prompt=hi");
    expect(withThreadWalkthroughLink("?walkthrough=diff&expanded=true", null)).toBe("");
  });

  it("reads a bare ?walkthrough as a request for the default target", () => {
    expect(readThreadWalkthroughLink("?walkthrough")).toEqual({
      walkthrough: "",
      expanded: false,
    });
    expect(readThreadWalkthroughLink("?expanded=true")).toBeNull();
  });

  it("names only a walkthrough the panel shows", () => {
    const base = { diffView: "walkthrough" as const, pullRequestUrl: prUrl, maximized: true };
    expect(
      shownThreadWalkthroughLink({ ...base, activeSurface: { id: "diff", kind: "diff" } }),
    ).toEqual({
      walkthrough: "diff",
      expanded: true,
    });
    expect(
      shownThreadWalkthroughLink({
        ...base,
        diffView: "diff",
        activeSurface: { id: "diff", kind: "diff" },
      }),
    ).toBeNull();
    const pullRequest = {
      id: "pull-request:p:acme%2Fweb:2" as const,
      kind: "pull-request" as const,
      projectId: "p",
      repository: "acme/web",
      number: 2,
    };
    expect(
      shownThreadWalkthroughLink({
        ...base,
        maximized: false,
        activeSurface: { ...pullRequest, detailTab: "walkthrough" },
      }),
    ).toEqual({ walkthrough: prUrl, expanded: false });
    expect(
      shownThreadWalkthroughLink({ ...base, activeSurface: { ...pullRequest, detailTab: "code" } }),
    ).toBeNull();
    expect(
      shownThreadWalkthroughLink({
        ...base,
        pullRequestUrl: null,
        activeSurface: { ...pullRequest, detailTab: "walkthrough" },
      }),
    ).toBeNull();
    expect(shownThreadWalkthroughLink({ ...base, activeSurface: null })).toBeNull();
  });

  it("shares a thread's walkthrough through the hosted thread link", () => {
    expect(
      walkthroughShareUrl({
        href: "/env-1/thread-1?walkthrough=diff&expanded=true",
        origin: "http://localhost:3000",
        threadRef: {
          environmentId: EnvironmentId.make("env-1"),
          threadId: ThreadId.make("thread-1"),
        },
        hostedAppUrl: "https://app.t3.codes",
      }),
    ).toBe("https://app.t3.codes/threads/env-1/thread-1?walkthrough=diff&expanded=true");
    expect(
      walkthroughShareUrl({
        href: "/pull-requests?number=2&walkthrough=true",
        origin: "http://localhost:3000",
        threadRef: null,
        hostedAppUrl: "https://app.t3.codes",
      }),
    ).toBe("http://localhost:3000/pull-requests?number=2&walkthrough=true");
  });
});
