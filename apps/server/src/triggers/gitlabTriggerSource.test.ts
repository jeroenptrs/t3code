import { assert, describe, it } from "@effect/vitest";
import { ScheduledTaskId, type ThreadPullRequestSnapshot } from "@t3tools/contracts";

import {
  diffGitLabProjectsMergeRequest,
  diffPipeline,
  diffPullRequest,
  type GitLabPipelineState,
} from "./gitlabTriggerSource.ts";

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

describe("GitLab projects source", () => {
  const context = { triggerId: ScheduledTaskId.make("task:projects"), occurredAt: AT };
  const pipeline = (overrides: Partial<GitLabPipelineState> = {}): GitLabPipelineState => ({
    id: "901",
    repository: "group/app",
    status: "running",
    ref: "refs/merge-requests/42/head",
    url: "https://gitlab.acme.dev/group/app/-/pipelines/901",
    updatedAt: "2026-11-05T09:00:00.000Z",
    ...overrides,
  });
  const finished = (previous: GitLabPipelineState | null, current: GitLabPipelineState) =>
    diffPipeline(previous, current, null, "gitlab.acme.dev", context).map((event) => event.type);

  it("raises a polled merge request's first sight as opened only while open, for its trigger", () => {
    const [opened, ...rest] = diffGitLabProjectsMergeRequest(null, snapshot(), key, context);
    assert.deepEqual(rest, []);
    assert.equal(opened?.source, "gitlab_projects");
    assert.equal(opened?.type, "merge_request.opened");
    assert.equal(opened?.triggerId, "task:projects");
    assert.deepInclude(opened?.payload, { number: "42", pipelineId: null, pipelineStatus: null });
    assert.deepEqual(
      diffGitLabProjectsMergeRequest(null, snapshot({ state: "merged" }), key, context),
      [],
    );
    // Pipelines raise their own events, so checks transitions do not.
    assert.deepEqual(
      diffGitLabProjectsMergeRequest(
        snapshot(),
        snapshot({ state: "merged", checksState: "failing" }),
        key,
        context,
      ).map((event) => event.type),
      ["merge_request.merged"],
    );
  });

  it("raises pipeline.finished once, when a pipeline is first seen terminal", () => {
    for (const status of ["success", "failed", "canceled", "skipped"]) {
      assert.deepEqual(finished(pipeline(), pipeline({ status })), ["pipeline.finished"]);
      assert.deepEqual(finished(null, pipeline({ status })), ["pipeline.finished"]);
      assert.deepEqual(finished(pipeline({ status }), pipeline({ status: "failed" })), []);
    }
    assert.deepEqual(finished(null, pipeline()), []);
    assert.deepEqual(finished(pipeline({ status: "pending" }), pipeline({ status: "manual" })), []);
    // A retry runs it again, so its new end raises again.
    assert.deepEqual(finished(pipeline({ status: "running" }), pipeline({ status: "success" })), [
      "pipeline.finished",
    ]);
  });

  it("describes a pipeline's merge request when the poll knows it", () => {
    const [known] = diffPipeline(
      pipeline(),
      pipeline({ status: "failed" }),
      { key, snapshot: snapshot() },
      "gitlab.acme.dev",
      context,
    );
    assert.deepInclude(known?.payload, {
      type: "pipeline.finished",
      number: "42",
      title: "Add login",
      checksState: "failing",
      previousChecksState: "pending",
      pipelineId: "901",
      pipelineStatus: "failed",
      pipelineRef: "refs/merge-requests/42/head",
      pipelineUrl: "https://gitlab.acme.dev/group/app/-/pipelines/901",
    });
    const [branch] = diffPipeline(
      null,
      pipeline({ status: "success", ref: "main" }),
      null,
      "gitlab.acme.dev",
      context,
    );
    assert.deepInclude(branch?.payload, { number: "", url: "", headBranch: "main" });
  });
});
