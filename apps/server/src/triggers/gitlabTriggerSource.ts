import type {
  PullRequestChecksState,
  ScheduledTaskId,
  ThreadPullRequestSnapshot,
  TriggerEvent,
  TriggerGitLabEventPayload,
  TriggerGitLabEventType,
  TriggerGitLabProjectsEventType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface PullRequestTriggerKey {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

/** The observation and event key of one merge request. */
export const gitlabTriggerKey = (
  key: Pick<PullRequestTriggerKey, "host" | "repository" | "number">,
) => `${key.host}\u0000${key.repository}\u0000${key.number}`;

/** The observation and event key of one pipeline, apart from merge request keys. */
export const gitlabPipelineKey = (host: string, repository: string, pipelineId: string) =>
  `${host}\u0000${repository}\u0000pipeline\u0000${pipelineId}`;

/**
 * The merge request changes since `previous`, as trigger events. The first observation raises
 * only `merge_request.opened`, and only for an open merge request.
 */
export function diffPullRequest(
  previous: ThreadPullRequestSnapshot | null,
  current: ThreadPullRequestSnapshot,
  key: PullRequestTriggerKey,
  occurredAt: string,
): ReadonlyArray<TriggerEvent> {
  const types: Array<TriggerGitLabEventType> = [];
  const checksState = current.checksState ?? null;
  const previousChecksState = previous?.checksState ?? null;
  if (previous === null) {
    if (current.state === "open") types.push("merge_request.opened");
  } else {
    if (previous.state !== current.state) {
      if (current.state === "merged") types.push("merge_request.merged");
      if (current.state === "closed") types.push("merge_request.closed");
    }
    if (
      current.state === "open" &&
      (previous.updatedAt !== current.updatedAt ||
        previous.title !== current.title ||
        previous.isDraft !== current.isDraft ||
        previous.baseBranch !== current.baseBranch)
    ) {
      types.push("merge_request.updated");
    }
    if (checksState !== previousChecksState) {
      if (checksState === "failing") types.push("pipeline.failed");
      if (checksState === "passing") types.push("pipeline.passed");
    }
  }

  const fields: Omit<TriggerGitLabEventPayload, "type"> = {
    host: key.host,
    repository: key.repository,
    number: String(key.number),
    url: key.url,
    title: current.title,
    state: current.state,
    previousState: previous?.state ?? null,
    isDraft: current.isDraft ? "true" : "false",
    headBranch: current.headBranch,
    baseBranch: current.baseBranch,
    checksState,
    previousChecksState,
    reviewDecision: current.reviewDecision ?? null,
    author: current.author?.login ?? null,
  };
  return types.map((type) => ({
    source: "gitlab",
    type,
    occurredAt,
    payload: { type, ...fields },
  }));
}

type GitLabProjectsEvent = Extract<TriggerEvent, { readonly source: "gitlab_projects" }>;

interface GitLabProjectsContext {
  readonly triggerId: ScheduledTaskId;
  readonly occurredAt: string;
}

const NO_PIPELINE = {
  pipelineId: null,
  pipelineStatus: null,
  pipelineUrl: null,
  pipelineRef: null,
} as const;

const isGitLabProjectsType = (type: string): type is TriggerGitLabProjectsEventType =>
  type.startsWith("merge_request.");

/**
 * A polled merge request's changes, by the same rules as a linked one, for the trigger that
 * polled it. Pipelines raise their own events, so the checks state transitions do not.
 */
export function diffGitLabProjectsMergeRequest(
  previous: ThreadPullRequestSnapshot | null,
  current: ThreadPullRequestSnapshot,
  key: PullRequestTriggerKey,
  context: GitLabProjectsContext,
): ReadonlyArray<GitLabProjectsEvent> {
  return diffPullRequest(previous, current, key, context.occurredAt).flatMap((event) =>
    event.source === "gitlab" && isGitLabProjectsType(event.type)
      ? [
          {
            source: "gitlab_projects",
            type: event.type,
            triggerId: context.triggerId,
            occurredAt: context.occurredAt,
            payload: { ...event.payload, type: event.type, ...NO_PIPELINE },
          },
        ]
      : [],
  );
}

/** What a poll keeps of one pipeline. */
export const GitLabPipelineState = Schema.Struct({
  id: Schema.String,
  repository: Schema.String,
  status: Schema.String,
  ref: Schema.String,
  url: Schema.String,
  updatedAt: Schema.String,
});
export type GitLabPipelineState = typeof GitLabPipelineState.Type;

const TERMINAL_PIPELINE_STATUSES: ReadonlySet<string> = new Set([
  "success",
  "failed",
  "canceled",
  "skipped",
]);

export const isFinishedPipeline = (pipeline: Pick<GitLabPipelineState, "status">) =>
  TERMINAL_PIPELINE_STATUSES.has(pipeline.status);

const toChecksState = (status: string | undefined): PullRequestChecksState | null => {
  if (status === undefined) return null;
  if (status === "success") return "passing";
  if (status === "failed" || status === "canceled") return "failing";
  return status === "skipped" ? null : "pending";
};

/** A merge request pipeline runs on refs/merge-requests/<iid>/head. */
export const mergeRequestNumberOfRef = (ref: string): number | null => {
  const match = /^refs\/merge-requests\/(\d+)\/(?:head|merge|train)$/.exec(ref);
  return match === null ? null : Number(match[1]);
};

/**
 * `pipeline.finished` once, when a pipeline is first seen terminal: success, failed, canceled,
 * or skipped. A retry that runs it again raises again when it ends. The merge request fields
 * describe the merge request the pipeline ran for, when the poll knows it, and are empty
 * otherwise.
 */
export function diffPipeline(
  previous: GitLabPipelineState | null,
  current: GitLabPipelineState,
  mergeRequest: {
    readonly key: PullRequestTriggerKey;
    readonly snapshot: ThreadPullRequestSnapshot;
  } | null,
  host: string,
  context: GitLabProjectsContext,
): ReadonlyArray<GitLabProjectsEvent> {
  if (!isFinishedPipeline(current) || (previous !== null && isFinishedPipeline(previous))) {
    return [];
  }
  const snapshot = mergeRequest?.snapshot ?? null;
  const type = "pipeline.finished";
  return [
    {
      source: "gitlab_projects",
      type,
      triggerId: context.triggerId,
      occurredAt: context.occurredAt,
      payload: {
        type,
        host,
        repository: current.repository,
        number: mergeRequest === null ? "" : String(mergeRequest.key.number),
        url: mergeRequest?.key.url ?? "",
        title: snapshot?.title ?? "",
        state: snapshot?.state ?? "",
        previousState: snapshot?.state ?? null,
        isDraft: snapshot?.isDraft === true ? "true" : "false",
        headBranch: snapshot?.headBranch ?? current.ref,
        baseBranch: snapshot?.baseBranch ?? "",
        checksState: toChecksState(current.status),
        previousChecksState: toChecksState(previous?.status),
        reviewDecision: snapshot?.reviewDecision ?? null,
        author: snapshot?.author?.login ?? null,
        pipelineId: current.id,
        pipelineStatus: current.status,
        pipelineUrl: current.url,
        pipelineRef: current.ref,
      },
    },
  ];
}
