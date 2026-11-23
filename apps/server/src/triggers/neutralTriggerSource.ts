/**
 * Issues and pull request triggers: what one poll of a project's trackers and hosts saw, kept per
 * item, and the events between two observations of an item. Plain functions; the poll is in
 * `neutralPoller.ts` and the storage in `TriggerSources`.
 */
import {
  type IssueListEntry,
  type PullRequestListEntry,
  type ScheduledTaskId,
  type TriggerEvent,
  type TriggerIssuesEventType,
  type TriggerPullRequestsEventType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const StringList = Schema.Array(Schema.String);

/** What an issues trigger keeps per issue: the fields its events and diffs read. */
export const IssueTriggerState = Schema.Struct({
  tracker: Schema.String,
  host: Schema.String,
  scope: Schema.String,
  key: Schema.String,
  displayKey: Schema.String,
  url: Schema.String,
  title: Schema.String,
  state: Schema.String,
  stateCategory: Schema.String,
  author: Schema.NullOr(Schema.String),
  assignees: StringList,
  labels: StringList,
  updatedAt: Schema.String,
});
export type IssueTriggerState = typeof IssueTriggerState.Type;

/** What a pull requests trigger keeps per pull request. */
export const PullRequestTriggerState = Schema.Struct({
  provider: Schema.String,
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Number,
  url: Schema.String,
  title: Schema.String,
  state: Schema.String,
  isDraft: Schema.Boolean,
  headBranch: Schema.String,
  baseBranch: Schema.String,
  checksState: Schema.NullOr(Schema.String),
  reviewDecision: Schema.NullOr(Schema.String),
  author: Schema.NullOr(Schema.String),
  labels: StringList,
  updatedAt: Schema.String,
});
export type PullRequestTriggerState = typeof PullRequestTriggerState.Type;

const sorted = (values: ReadonlyArray<string>) => values.toSorted();

export const issueTriggerState = (entry: IssueListEntry): IssueTriggerState => ({
  tracker: entry.tracker,
  host: entry.host,
  scope: entry.scope,
  key: entry.key,
  displayKey: entry.displayKey,
  url: entry.url,
  title: entry.title,
  state: entry.state.name,
  stateCategory: entry.state.category,
  author: entry.author?.login ?? null,
  assignees: sorted(entry.assignees.map((actor) => actor.login)),
  labels: sorted(entry.labels.map((label) => label.name)),
  updatedAt: entry.updatedAt,
});

export const pullRequestTriggerState = (entry: PullRequestListEntry): PullRequestTriggerState => ({
  provider: entry.provider,
  host: entry.host,
  repository: entry.repository,
  number: entry.number,
  url: entry.url,
  title: entry.title,
  state: entry.state,
  isDraft: entry.isDraft,
  headBranch: entry.headBranch,
  baseBranch: entry.baseBranch,
  checksState: entry.checksState ?? null,
  reviewDecision: entry.reviewDecision ?? null,
  author: entry.author?.login ?? null,
  labels: sorted(entry.labels.map((label) => label.name)),
  updatedAt: entry.updatedAt,
});

/** The observation and event key of one issue, under its trigger's prefix. */
export const issueTriggerKey = (
  state: Pick<IssueTriggerState, "tracker" | "host" | "scope" | "key">,
) => `${state.tracker}\u0000${state.host}\u0000${state.scope}\u0000${state.key}`;

/** The observation and event key of one pull request. */
export const pullRequestTriggerKey = (
  state: Pick<PullRequestTriggerState, "provider" | "host" | "repository" | "number">,
) => `${state.provider}\u0000${state.host}\u0000${state.repository}\u0000${state.number}`;

/** Whether an item has ended, so its row may be forgotten once it has not changed for a while. */
export const hasEnded = (state: IssueTriggerState | PullRequestTriggerState) =>
  "stateCategory" in state ? state.stateCategory === "closed" : state.state !== "open";

interface DiffContext {
  readonly triggerId: ScheduledTaskId;
  readonly occurredAt: string;
}

const added = (from: ReadonlyArray<string>, to: ReadonlyArray<string>) =>
  to.filter((value) => !from.includes(value));

/**
 * The issue's changes since `previous`, as events. A first observation raises `issue.opened` for
 * an open issue only. `issue.updated` stands for any other change, such as a comment.
 */
export function diffIssue(
  previous: IssueTriggerState | null,
  current: IssueTriggerState,
  context: DiffContext,
): ReadonlyArray<TriggerEvent> {
  const types: Array<TriggerIssuesEventType> = [];
  if (previous === null) {
    if (current.stateCategory === "open") types.push("issue.opened");
  } else {
    if (previous.stateCategory !== current.stateCategory) {
      types.push(current.stateCategory === "closed" ? "issue.closed" : "issue.reopened");
    } else if (previous.state !== current.state) {
      types.push("issue.state_changed");
    }
    if (previous.labels.join("\n") !== current.labels.join("\n")) {
      types.push("issue.labels_changed");
    }
    if (previous.assignees.join("\n") !== current.assignees.join("\n")) {
      types.push("issue.assignee_changed");
    }
    if (types.length === 0 && previous.updatedAt !== current.updatedAt) {
      types.push("issue.updated");
    }
  }
  return types.map((type) => ({
    source: "issues",
    type,
    triggerId: context.triggerId,
    occurredAt: context.occurredAt,
    payload: {
      type,
      tracker: current.tracker,
      host: current.host,
      scope: current.scope,
      key: current.key,
      displayKey: current.displayKey,
      url: current.url,
      title: current.title,
      state: current.state,
      stateCategory: current.stateCategory,
      previousState: previous?.state ?? null,
      previousStateCategory: previous?.stateCategory ?? null,
      author: current.author,
      assignees: current.assignees,
      labels: current.labels,
      addedLabels: added(previous?.labels ?? [], current.labels),
      removedLabels: added(current.labels, previous?.labels ?? []),
    },
  }));
}

/**
 * The pull request's changes since `previous`, as events. A first observation raises
 * `pull_request.opened` for an open one only.
 */
export function diffPullRequestEntry(
  previous: PullRequestTriggerState | null,
  current: PullRequestTriggerState,
  context: DiffContext,
): ReadonlyArray<TriggerEvent> {
  const types: Array<TriggerPullRequestsEventType> = [];
  if (previous === null) {
    if (current.state === "open") types.push("pull_request.opened");
  } else {
    if (previous.state !== current.state) {
      types.push(
        current.state === "merged"
          ? "pull_request.merged"
          : current.state === "closed"
            ? "pull_request.closed"
            : "pull_request.reopened",
      );
    }
    const checksChanged = previous.checksState !== current.checksState;
    if (checksChanged && current.state === "open") types.push("pull_request.checks_changed");
    const edited =
      previous.title !== current.title ||
      previous.isDraft !== current.isDraft ||
      previous.baseBranch !== current.baseBranch;
    // A host moves `updatedAt` when checks finish, which checks_changed already says.
    const touched = previous.updatedAt !== current.updatedAt && !checksChanged;
    if (current.state === "open" && previous.state === "open" && (edited || touched)) {
      types.push("pull_request.updated");
    }
  }
  return types.map((type) => ({
    source: "pull_requests",
    type,
    triggerId: context.triggerId,
    occurredAt: context.occurredAt,
    payload: {
      type,
      provider: current.provider,
      host: current.host,
      repository: current.repository,
      number: String(current.number),
      url: current.url,
      title: current.title,
      state: current.state,
      previousState: previous?.state ?? null,
      isDraft: current.isDraft ? "true" : "false",
      headBranch: current.headBranch,
      baseBranch: current.baseBranch,
      checksState: current.checksState,
      previousChecksState: previous?.checksState ?? null,
      reviewDecision: current.reviewDecision,
      author: current.author,
      labels: current.labels,
    },
  }));
}
