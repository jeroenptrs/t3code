import { assert, describe, it } from "@effect/vitest";
import type { ThreadPullRequestSnapshot } from "@t3tools/contracts";

import { diffPullRequest } from "./gitlabTriggerSource.ts";

const AT = "2026-11-05T10:00:00.000Z";
const key = {
  host: "gitlab.acme.dev",
  repository: "group/app",
  number: 42,
  url: "https://gitlab.acme.dev/group/app/-/merge_requests/42",
};

const snapshot = (
  overrides: Partial<ThreadPullRequestSnapshot> = {},
): ThreadPullRequestSnapshot => ({
  state: "open",
  title: "Add login",
  headBranch: "feature/login",
  baseBranch: "main",
  isDraft: false,
  updatedAt: "2026-11-05T09:00:00.000Z",
  syncedAt: "2026-11-05T09:00:00.000Z",
  author: { login: "ada", name: null, avatarUrl: null },
  reviewDecision: null,
  checksState: "pending",
  ...overrides,
});

const types = (previous: ThreadPullRequestSnapshot | null, current: ThreadPullRequestSnapshot) =>
  diffPullRequest(previous, current, key, AT).map((event) => event.type);

describe("diffPullRequest", () => {
  it("raises opened on the first observation of an open merge request only", () => {
    const [opened, ...rest] = diffPullRequest(null, snapshot(), key, AT);
    assert.deepEqual(rest, []);
    assert.deepEqual(opened, {
      source: "gitlab",
      type: "merge_request.opened",
      occurredAt: AT,
      payload: {
        type: "merge_request.opened",
        host: "gitlab.acme.dev",
        repository: "group/app",
        number: "42",
        url: "https://gitlab.acme.dev/group/app/-/merge_requests/42",
        title: "Add login",
        state: "open",
        previousState: null,
        isDraft: "false",
        headBranch: "feature/login",
        baseBranch: "main",
        checksState: "pending",
        previousChecksState: null,
        reviewDecision: null,
        author: "ada",
      },
    });
    assert.deepEqual(types(null, snapshot({ state: "merged" })), []);
    assert.deepEqual(types(null, snapshot({ state: "closed", checksState: "failing" })), []);
  });

  it("raises nothing when only the sync time moved", () => {
    assert.deepEqual(types(snapshot(), snapshot({ syncedAt: AT })), []);
  });

  it("raises updated on an update, title, draft, or target branch change while open", () => {
    assert.deepEqual(types(snapshot(), snapshot({ updatedAt: AT })), ["merge_request.updated"]);
    assert.deepEqual(types(snapshot(), snapshot({ title: "Add SSO" })), ["merge_request.updated"]);
    const [draft] = diffPullRequest(snapshot(), snapshot({ isDraft: true }), key, AT);
    assert.equal(draft?.type, "merge_request.updated");
    assert.deepInclude(draft?.payload, { isDraft: "true", previousState: "open" });
    assert.deepEqual(types(snapshot(), snapshot({ baseBranch: "develop" })), [
      "merge_request.updated",
    ]);
  });

  it("raises merged and closed on state transitions, not updated", () => {
    assert.deepEqual(types(snapshot(), snapshot({ state: "merged", updatedAt: AT })), [
      "merge_request.merged",
    ]);
    const [closed] = diffPullRequest(snapshot(), snapshot({ state: "closed" }), key, AT);
    assert.equal(closed?.type, "merge_request.closed");
    assert.deepInclude(closed?.payload, { state: "closed", previousState: "open" });
    assert.deepEqual(types(snapshot({ state: "closed" }), snapshot({ state: "closed" })), []);
  });

  it("raises pipeline events when checks turn failing or passing", () => {
    const [failed] = diffPullRequest(snapshot(), snapshot({ checksState: "failing" }), key, AT);
    assert.equal(failed?.type, "pipeline.failed");
    assert.deepInclude(failed?.payload, {
      checksState: "failing",
      previousChecksState: "pending",
    });
    assert.deepEqual(
      types(snapshot({ checksState: "failing" }), snapshot({ checksState: "passing" })),
      ["pipeline.passed"],
    );
    assert.deepEqual(
      types(snapshot({ checksState: "passing" }), snapshot({ checksState: "passing" })),
      [],
    );
    assert.deepEqual(
      types(snapshot({ checksState: "failing" }), snapshot({ checksState: null })),
      [],
    );
  });

  it("raises every change one observation carries", () => {
    assert.deepEqual(types(snapshot(), snapshot({ state: "merged", checksState: "passing" })), [
      "merge_request.merged",
      "pipeline.passed",
    ]);
    assert.deepEqual(types(snapshot(), snapshot({ title: "Add SSO", checksState: "failing" })), [
      "merge_request.updated",
      "pipeline.failed",
    ]);
  });
});
