import type {
  ThreadPullRequestSnapshot,
  TriggerEvent,
  TriggerGitLabEventPayload,
  TriggerGitLabEventType,
} from "@t3tools/contracts";

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
