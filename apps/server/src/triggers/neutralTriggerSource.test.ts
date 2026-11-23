import { ScheduledTaskId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { diffPullRequestEntry, type PullRequestTriggerState } from "./neutralTriggerSource.ts";

const context = {
  triggerId: ScheduledTaskId.make("task:prs"),
  occurredAt: "2026-11-05T09:00:00.000Z",
};

const pullRequest = (
  overrides: Partial<PullRequestTriggerState> = {},
): PullRequestTriggerState => ({
  provider: "gitlab",
  host: "gitlab.acme.dev",
  repository: "group/app",
  number: 42,
  url: "https://gitlab.acme.dev/group/app/-/merge_requests/42",
  title: "Add login",
  state: "open",
  isDraft: false,
  headBranch: "feature/login",
  baseBranch: "main",
  checksState: "pending",
  reviewDecision: null,
  author: "ada",
  labels: [],
  updatedAt: "2026-11-05T09:00:00.000Z",
  ...overrides,
});

const types = (previous: PullRequestTriggerState | null, current: PullRequestTriggerState) =>
  diffPullRequestEntry(previous, current, context).map((event) => event.type);

describe("diffPullRequestEntry", () => {
  it.each([
    ["a first sight of an open one", null, pullRequest(), ["pull_request.opened"]],
    ["a first sight of a merged one", null, pullRequest({ state: "merged" }), []],
    [
      "checks finishing, which also moves updatedAt",
      pullRequest(),
      pullRequest({ checksState: "passing", updatedAt: "2026-11-05T09:05:00.000Z" }),
      ["pull_request.checks_changed"],
    ],
    [
      "an edit while checks change",
      pullRequest(),
      pullRequest({ checksState: "failing", title: "Add SSO login" }),
      ["pull_request.checks_changed", "pull_request.updated"],
    ],
    [
      "a merge",
      pullRequest(),
      pullRequest({ state: "merged", updatedAt: "2026-11-05T10:00:00.000Z" }),
      ["pull_request.merged"],
    ],
    ["a reopen", pullRequest({ state: "closed" }), pullRequest(), ["pull_request.reopened"]],
  ] as const)("raises the right events for %s", (_case, previous, current, expected) => {
    expect(types(previous, current)).toEqual(expected);
  });

  it("names the previous state and checks on the event", () => {
    const [event] = diffPullRequestEntry(
      pullRequest(),
      pullRequest({ checksState: "failing" }),
      context,
    );
    expect(event?.payload).toMatchObject({
      number: "42",
      checksState: "failing",
      previousChecksState: "pending",
      previousState: "open",
    });
  });
});
