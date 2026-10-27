/**
 * Fork-only Jira Cloud read side. The server reads Jira over REST as one designated identity and
 * clients only ever see the public shapes here; tokens never leave the server.
 */
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { AuthUserId } from "./authUser.ts";
import { PullRequestState } from "./pullRequest.ts";
import { ThreadPullRequestKey } from "./threadPullRequest.ts";

/**
 * `scoped-token`: a service account's scoped API token, sent as a bearer token through
 * `api.atlassian.com/ex/jira/{cloudId}`. `basic`: an email plus classic API token against the
 * site URL.
 */
export const JiraAuthMethod = Schema.Literals(["scoped-token", "basic"]);
export type JiraAuthMethod = typeof JiraAuthMethod.Type;

/** A configured server-side Jira identity as clients may see it: no token, email or cloud id. */
export const JiraIdentity = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** Site host, such as `acme.atlassian.net`. Issue keys are qualified by it. */
  site: TrimmedNonEmptyString,
  authMethod: JiraAuthMethod,
  /** This identity serves every read the UI makes. Exactly one identity is the reader. */
  reader: Schema.Boolean,
});
export type JiraIdentity = typeof JiraIdentity.Type;

/** Jira Cloud project keys are an uppercase letter then uppercase letters, digits or `_`. */
export const JIRA_ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]+-[1-9]\d*$/;

export const JiraIssueKeyString = TrimmedNonEmptyString.check(
  Schema.isPattern(JIRA_ISSUE_KEY_PATTERN),
);
export type JiraIssueKeyString = typeof JiraIssueKeyString.Type;

/** Identity of an issue across the app. `site` is the lowercase site host. */
export const JiraIssueKey = Schema.Struct({
  site: TrimmedNonEmptyString,
  key: JiraIssueKeyString,
});
export type JiraIssueKey = typeof JiraIssueKey.Type;

/**
 * Jira's three status categories, which every workflow maps its statuses onto. Anything generic
 * keys off this rather than a status name, since status names differ per project.
 * Jira's own keys are `new`, `indeterminate` and `done`.
 */
export const JiraStatusCategory = Schema.Literals(["todo", "in-progress", "done"]);
export type JiraStatusCategory = typeof JiraStatusCategory.Type;

export const JiraUser = Schema.Struct({
  accountId: TrimmedNonEmptyString,
  displayName: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
});
export type JiraUser = typeof JiraUser.Type;

export const JiraSprintState = Schema.Literals(["active", "future", "closed"]);
export type JiraSprintState = typeof JiraSprintState.Type;

/** A sprint as the issue's sprint field reports it; scoped tokens cannot read the Agile API. */
export const JiraSprint = Schema.Struct({
  id: PositiveInt,
  name: Schema.String,
  state: JiraSprintState,
});
export type JiraSprint = typeof JiraSprint.Type;

/**
 * A sprint a project can plan into. Without the Agile API the server finds sprints two ways: on
 * the sprint field of the project's issues, which carries state and dates, and in Jira's JQL
 * autocomplete, which also lists empty sprints but says nothing else. A sprint known only from
 * autocomplete is `future` with null dates.
 */
export const JiraProjectSprint = Schema.Struct({
  ...JiraSprint.fields,
  startDate: Schema.NullOr(IsoDateTime),
  endDate: Schema.NullOr(IsoDateTime),
  /** When a closed sprint was completed; null for open sprints. */
  completeDate: Schema.NullOr(IsoDateTime),
});
export type JiraProjectSprint = typeof JiraProjectSprint.Type;

/** The row shape: what a list, a facet or a link card needs, and nothing that is long. */
export const JiraIssueInput = Schema.Struct({
  ...JiraIssueKey.fields,
  /** Skip the server's read cache, for an explicit refresh. */
  refresh: Schema.optional(Schema.Boolean),
});
export type JiraIssueInput = typeof JiraIssueInput.Type;

export const JiraIssueSummary = Schema.Struct({
  ...JiraIssueKey.fields,
  /** Browse URL on the site. */
  url: TrimmedNonEmptyString,
  summary: Schema.String,
  status: Schema.String,
  statusCategory: JiraStatusCategory,
  issueType: Schema.NullOr(Schema.String),
  /** The epic or parent issue; null for a top-level issue. */
  parentKey: Schema.NullOr(JiraIssueKeyString),
  priority: Schema.NullOr(Schema.String),
  assignee: Schema.NullOr(JiraUser),
  /** Sprints in field order; empty when the site has no sprint field or the issue is in none. */
  sprints: Schema.Array(JiraSprint),
  /** Null when the site has no story points field or the issue has no estimate. */
  storyPoints: Schema.NullOr(Schema.Number),
  updated: Schema.NullOr(IsoDateTime),
});
export type JiraIssueSummary = typeof JiraIssueSummary.Type;

export const JiraComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: Schema.NullOr(JiraUser),
  /** Markdown converted from Atlassian Document Format on the server. */
  body: Schema.String,
  created: IsoDateTime,
  updated: Schema.NullOr(IsoDateTime),
});
export type JiraComment = typeof JiraComment.Type;

/** A transition the reader could take. Read only in phase one; nothing in the UI performs it. */
export const JiraTransition = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  toStatus: Schema.String,
  toStatusCategory: JiraStatusCategory,
});
export type JiraTransition = typeof JiraTransition.Type;

/**
 * Who linked an issue to a thread. `branch` is the server noticing the key in the thread's
 * branch name. `branch-dismissed` is a tombstone for any link that was unlinked, so the branch
 * detector does not re-add it; clients hide it.
 */
export const ThreadJiraIssueLinkSource = Schema.Literals([
  "manual",
  "branch",
  "agent",
  "branch-dismissed",
]);
export type ThreadJiraIssueLinkSource = typeof ThreadJiraIssueLinkSource.Type;

export const JiraLinkedThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  archivedAt: Schema.NullOr(IsoDateTime),
  source: ThreadJiraIssueLinkSource,
});
export type JiraLinkedThread = typeof JiraLinkedThread.Type;

/**
 * A pull request that names the issue key in its branch, title or description, found among the
 * pull requests T3 already knows about. Jira's Development panel is never read.
 */
export const JiraLinkedPullRequest = Schema.Struct({
  ...ThreadPullRequestKey.fields,
  url: TrimmedNonEmptyString,
  title: Schema.String,
  state: Schema.NullOr(PullRequestState),
  headBranch: Schema.NullOr(TrimmedNonEmptyString),
  /** Threads that link this pull request. */
  threadIds: Schema.Array(ThreadId),
});
export type JiraLinkedPullRequest = typeof JiraLinkedPullRequest.Type;

export const JiraIssueDetail = Schema.Struct({
  ...JiraIssueSummary.fields,
  reporter: Schema.NullOr(JiraUser),
  created: Schema.NullOr(IsoDateTime),
  /** Markdown converted from Atlassian Document Format on the server; null when empty. */
  description: Schema.NullOr(Schema.String),
  /** Most recent last is Jira's order; capped server side. */
  comments: Schema.Array(JiraComment),
  /** Total comments on the issue, which may exceed `comments.length`. */
  commentCount: NonNegativeInt,
  transitions: Schema.Array(JiraTransition),
  linkedThreads: Schema.Array(JiraLinkedThread),
  pullRequests: Schema.Array(JiraLinkedPullRequest),
});
export type JiraIssueDetail = typeof JiraIssueDetail.Type;

/** A Jira saved filter, which is what a T3 view points at. Name and JQL are read at use time. */
export const JiraFilterView = Schema.Struct({
  site: TrimmedNonEmptyString,
  id: TrimmedNonEmptyString,
  name: Schema.String,
  jql: Schema.String,
  owner: Schema.NullOr(Schema.String),
  /** Starred by the reader identity. */
  favourite: Schema.Boolean,
  url: TrimmedNonEmptyString,
});
export type JiraFilterView = typeof JiraFilterView.Type;

/**
 * A portal user's own Jira token as clients may see it: never the token or the email. While one
 * is stored, that user's UI reads go out as them instead of the reader identity, and writes they
 * approve use it. Background work and agents never use it.
 */
export const JiraPersonalCredential = Schema.Struct({
  site: TrimmedNonEmptyString,
  /** The Jira account the token belongs to; null when it has never verified. */
  account: Schema.NullOr(JiraUser),
  createdAt: IsoDateTime,
  lastVerifiedAt: Schema.NullOr(IsoDateTime),
  /** Why Jira refused the token the last time it was used; null when it worked. */
  error: Schema.NullOr(Schema.String),
});
export type JiraPersonalCredential = typeof JiraPersonalCredential.Type;

/**
 * Store or replace the caller's personal token. Personal tokens always authenticate as email plus
 * token, which covers both a scoped and a classic Atlassian API token.
 */
export const JiraPersonalTokenSetInput = Schema.Struct({
  /** One of the server's configured sites; defaults to the reader's. */
  site: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
  email: TrimmedNonEmptyString.check(Schema.isMaxLength(320)),
  token: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
});
export type JiraPersonalTokenSetInput = typeof JiraPersonalTokenSetInput.Type;

/**
 * What the server can do with Jira, as data the UI gates on. `configured` false means no identity
 * is set up and every Jira surface should explain how to configure one instead.
 */
export const JiraCapabilities = Schema.Struct({
  configured: Schema.Boolean,
  identities: Schema.Array(JiraIdentity),
  reader: Schema.NullOr(JiraIdentity),
  /** The reader's account as Jira's `myself` reports it; null when unverified or failing. */
  viewer: Schema.NullOr(JiraUser),
  /** Why the reader cannot read right now, such as a rejected token; null when it can. */
  readerError: Schema.NullOr(Schema.String),
  /**
   * The caller may store a personal token: Jira is configured and the session belongs to a portal
   * user signed in through Entra.
   */
  personalTokens: Schema.Boolean,
  /** The caller's stored personal token; null when they have none. */
  personalCredential: Schema.NullOr(JiraPersonalCredential),
});
export type JiraCapabilities = typeof JiraCapabilities.Type;

const JiraJql = TrimmedNonEmptyString.check(Schema.isMaxLength(4000));

export const JiraFiltersInput = Schema.Struct({
  /** Narrow by filter name; absent lists the reader's favourites and its own filters. */
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type JiraFiltersInput = typeof JiraFiltersInput.Type;

export const JiraFiltersResult = Schema.Struct({
  filters: Schema.Array(JiraFilterView),
});
export type JiraFiltersResult = typeof JiraFiltersResult.Type;

export const JiraFilterInput = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
});
export type JiraFilterInput = typeof JiraFilterInput.Type;

/**
 * One page of issues. A view passes `filterId`; ad-hoc `jql` is the escape hatch. Exactly one of
 * the two must be present.
 */
export const JiraSearchInput = Schema.Struct({
  filterId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(40))),
  jql: Schema.optional(JiraJql),
  /** Default 100, capped at 100 by Jira. */
  maxResults: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
  nextPageToken: Schema.optional(TrimmedNonEmptyString),
  /** Skip the server's read cache, for an explicit refresh. */
  refresh: Schema.optional(Schema.Boolean),
});
export type JiraSearchInput = typeof JiraSearchInput.Type;

export const JiraSearchResult = Schema.Struct({
  issues: Schema.Array(JiraIssueSummary),
  nextPageToken: Schema.NullOr(TrimmedNonEmptyString),
  /** The filter the search ran, with its current name and JQL; null for ad-hoc JQL. */
  filter: Schema.NullOr(JiraFilterView),
});
export type JiraSearchResult = typeof JiraSearchResult.Type;

export class JiraError extends Schema.TaggedError<JiraError>()("JiraError", {
  /**
   * `not-configured`: no identity; `personal-token-required`: a write needs the caller's own
   * token and they have none; `unauthorized`/`forbidden`: Jira refused the identity;
   * `not-found`: the issue or filter does not exist or is not visible; `invalid`: the request or
   * JQL was rejected; `unavailable`: Jira could not be reached or failed.
   */
  reason: Schema.Literals([
    "not-configured",
    "personal-token-required",
    "unauthorized",
    "forbidden",
    "not-found",
    "invalid",
    "unavailable",
  ]),
  message: TrimmedNonEmptyString,
}) {}

/** The only issue state a thread shell carries; descriptions and comments are read lazily. */
export const ThreadJiraIssueSnapshot = Schema.Struct({
  summary: Schema.String,
  statusCategory: JiraStatusCategory,
  syncedAt: IsoDateTime,
});
export type ThreadJiraIssueSnapshot = typeof ThreadJiraIssueSnapshot.Type;

/**
 * The server watching a linked issue for the thread's agent: a new comment, a status category
 * change or an assignee change wakes the agent. The fields are what the last read saw, so the
 * next read can tell what changed. Starting a watch reads nothing; changes count from then.
 */
export const ThreadJiraIssueWatch = Schema.Struct({
  startedAt: IsoDateTime,
  /** The issue's `updated` at the last read; the sweep reads detail only when it moves. */
  updatedThrough: Schema.NullOr(IsoDateTime),
  /** Null until the first read after the watch started. */
  statusCategory: Schema.NullOr(JiraStatusCategory),
  assigneeAccountId: Schema.NullOr(Schema.String),
  /** Comments created at or before this are already known. */
  commentsThrough: IsoDateTime,
  /** Consecutive wakes for comments alone; a status or assignee change resets it. */
  wakes: NonNegativeInt,
});
export type ThreadJiraIssueWatch = typeof ThreadJiraIssueWatch.Type;

export const ThreadJiraIssueLink = Schema.Struct({
  ...JiraIssueKey.fields,
  source: ThreadJiraIssueLinkSource,
  linkedAt: IsoDateTime,
  /** Portal user who linked it; absent for the server, agents and users before attribution. */
  linkedByUserId: Schema.optional(AuthUserId),
  /** Null until the sync sweep first reads the issue. */
  snapshot: Schema.NullOr(ThreadJiraIssueSnapshot),
  /** Present while the server watches the issue for this thread's agent. */
  watch: Schema.optional(ThreadJiraIssueWatch),
});
export type ThreadJiraIssueLink = typeof ThreadJiraIssueLink.Type;

// Proposals: Jira writes an agent asks for and a user approves. The server performs an approved
// write with the approver's personal token, never a service account's, and records who approved.

/** Jira Cloud project keys: an uppercase letter, then uppercase letters, digits or `_`. */
export const JIRA_PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]+$/;
const JiraProjectKey = TrimmedNonEmptyString.check(Schema.isPattern(JIRA_PROJECT_KEY_PATTERN));

/** The project an issue key belongs to: everything before its last `-`. */
export const jiraProjectKeyOf = (issueKey: string): string =>
  issueKey.slice(0, issueKey.lastIndexOf("-")).toUpperCase();
/** Markdown the server converts to Atlassian Document Format when it writes. */
const JiraMarkdown = Schema.String.check(Schema.isMaxLength(32_000));
const JiraLabel = TrimmedNonEmptyString.check(Schema.isPattern(/^\S+$/), Schema.isMaxLength(255));

/** One issue an agent proposes to create. The approver may edit every field before approving. */
export const JiraIssueDraft = Schema.Struct({
  projectKey: JiraProjectKey,
  /** Issue type name as the project names it, such as `Story`, `Task`, `Bug` or `Sub-task`. */
  issueType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  description: Schema.NullOr(JiraMarkdown),
  /** An epic or parent issue; required by Jira for sub-tasks. */
  parentKey: Schema.NullOr(JiraIssueKeyString),
  labels: Schema.Array(JiraLabel).check(Schema.isMaxLength(20)),
  storyPoints: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Numeric sprint id, as the issue sprint field takes it. */
  sprintId: Schema.NullOr(PositiveInt),
  assigneeAccountId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type JiraIssueDraft = typeof JiraIssueDraft.Type;

export const JiraCreateIssuesProposal = Schema.Struct({
  kind: Schema.Literal("create-issues"),
  site: TrimmedNonEmptyString,
  issues: Schema.Array(JiraIssueDraft).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
});
export type JiraCreateIssuesProposal = typeof JiraCreateIssuesProposal.Type;

export const JiraCommentProposal = Schema.Struct({
  kind: Schema.Literal("comment"),
  ...JiraIssueKey.fields,
  body: JiraMarkdown.check(Schema.isMinLength(1)),
});
export type JiraCommentProposal = typeof JiraCommentProposal.Type;

/** Checked against the issue's available transitions again when it is approved. */
export const JiraTransitionProposal = Schema.Struct({
  kind: Schema.Literal("transition"),
  ...JiraIssueKey.fields,
  transitionId: TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
  /** The transition's name when proposed, shown on the card. */
  transitionName: Schema.String,
  /** Posted as a comment after the transition when present. */
  comment: Schema.NullOr(JiraMarkdown),
});
export type JiraTransitionProposal = typeof JiraTransitionProposal.Type;

export const JiraProposal = Schema.Union([
  JiraCreateIssuesProposal,
  JiraCommentProposal,
  JiraTransitionProposal,
]);
export type JiraProposal = typeof JiraProposal.Type;

/**
 * `pending` waits for a user. `approved` is being written to Jira. `applied` and `rejected` are
 * final. `failed` keeps whatever was already written and may be approved again, which writes only
 * what is missing.
 */
export const JiraProposalStatus = Schema.Literals([
  "pending",
  "approved",
  "applied",
  "rejected",
  "failed",
]);
export type JiraProposalStatus = typeof JiraProposalStatus.Type;

/** What an approval wrote. Issues are the created ones, or the issue commented on or transitioned. */
export const JiraProposalResult = Schema.Struct({
  issues: Schema.Array(
    Schema.Struct({
      ...JiraIssueKey.fields,
      url: TrimmedNonEmptyString,
      /** For `create-issues`, the draft this issue was created from. */
      draftIndex: Schema.optional(NonNegativeInt),
    }),
  ),
});
export type JiraProposalResult = typeof JiraProposalResult.Type;

/**
 * Approve, with the approver's edits, or reject. An edit may not change the proposal's kind,
 * site or issue key.
 */
export const JiraProposalDecisionInput = Schema.Struct({
  threadId: ThreadId,
  /** The proposal's turn item id. */
  proposalId: TrimmedNonEmptyString,
  decision: Schema.Union([
    Schema.Struct({ type: Schema.Literal("approve"), proposal: JiraProposal }),
    Schema.Struct({ type: Schema.Literal("reject") }),
  ]),
});
export type JiraProposalDecisionInput = typeof JiraProposalDecisionInput.Type;

export const JiraProposalDecisionResult = Schema.Struct({
  status: JiraProposalStatus,
  result: Schema.NullOr(JiraProposalResult),
  error: Schema.NullOr(Schema.String),
});
export type JiraProposalDecisionResult = typeof JiraProposalDecisionResult.Type;

/** What a proposal card offers for editing a draft in one project, read as the caller. */
export const JiraCreateMetaInput = Schema.Struct({
  site: TrimmedNonEmptyString,
  projectKey: JiraProjectKey,
});
export type JiraCreateMetaInput = typeof JiraCreateMetaInput.Type;

export const JiraCreateMeta = Schema.Struct({
  issueTypes: Schema.Array(
    Schema.Struct({ id: TrimmedNonEmptyString, name: Schema.String, subtask: Schema.Boolean }),
  ),
  /** The project's active and future sprints, as `jira.sprints` lists them. */
  sprints: Schema.Array(JiraProjectSprint),
});
export type JiraCreateMeta = typeof JiraCreateMeta.Type;

/** Sprints and velocity are read per Jira project, as the caller. */
export const JiraSprintsInput = Schema.Struct({
  site: TrimmedNonEmptyString,
  projectKey: JiraProjectKey,
  /** Skip the server's read cache, for an explicit refresh. */
  refresh: Schema.optional(Schema.Boolean),
});
export type JiraSprintsInput = typeof JiraSprintsInput.Type;

export const JiraSprintsResult = Schema.Struct({
  /** Active sprints first, then future ones, each by start date and then id. */
  sprints: Schema.Array(JiraProjectSprint),
});
export type JiraSprintsResult = typeof JiraSprintsResult.Type;

export const JiraVelocityInput = Schema.Struct({
  ...JiraSprintsInput.fields,
  /** Closed sprints to report, most recent first. Default 6. */
  lastN: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(20))),
});
export type JiraVelocityInput = typeof JiraVelocityInput.Type;

/**
 * Points in one closed sprint, from the issues the caller can see. `committed` counts every issue
 * the sprint field puts in the sprint, including ones added after it started, since the sprint
 * report is Agile API only. `completed` counts those resolved by the time the sprint completed.
 */
export const JiraSprintVelocity = Schema.Struct({
  sprint: JiraProjectSprint,
  committedPoints: Schema.Number,
  completedPoints: Schema.Number,
  issueCount: NonNegativeInt,
  completedIssueCount: NonNegativeInt,
});
export type JiraSprintVelocity = typeof JiraSprintVelocity.Type;

export const JiraVelocityResult = Schema.Struct({
  /** Most recently completed first. */
  sprints: Schema.Array(JiraSprintVelocity),
  /** Mean of `completedPoints` over `sprints`; null when there are none. */
  averageCompletedPoints: Schema.NullOr(Schema.Number),
  /** The read stopped at its issue cap, so older sprints may be undercounted. */
  partial: Schema.Boolean,
});
export type JiraVelocityResult = typeof JiraVelocityResult.Type;

/** Post a comment as the caller, with their personal token. */
export const JiraAddCommentInput = Schema.Struct({
  ...JiraIssueKey.fields,
  body: JiraMarkdown.check(Schema.isMinLength(1)),
});
export type JiraAddCommentInput = typeof JiraAddCommentInput.Type;

/** Take a transition as the caller, with their personal token, if the issue still offers it. */
export const JiraTransitionIssueInput = Schema.Struct({
  ...JiraIssueKey.fields,
  transitionId: TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
});
export type JiraTransitionIssueInput = typeof JiraTransitionIssueInput.Type;

/**
 * Put issues of one site in a sprint as the caller, with their personal token, by writing each
 * issue's sprint field. Rank is never changed.
 */
/** Issues one sprint move may write. */
export const JIRA_SET_SPRINT_MAX_KEYS = 50;
/** The largest estimate a story points write accepts. */
export const JIRA_STORY_POINTS_MAX = 10_000;

export const JiraSetSprintInput = Schema.Struct({
  site: TrimmedNonEmptyString,
  keys: Schema.Array(JiraIssueKeyString).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(JIRA_SET_SPRINT_MAX_KEYS),
  ),
  /** An active or future sprint; null moves the issues back to the backlog. */
  sprintId: Schema.NullOr(PositiveInt),
});
export type JiraSetSprintInput = typeof JiraSetSprintInput.Type;

/** Each issue is written on its own, so some may move while Jira refuses others. */
export const JiraSetSprintResult = Schema.Struct({
  updated: Schema.Array(JiraIssueKeyString),
  failed: Schema.Array(Schema.Struct({ key: JiraIssueKeyString, message: Schema.String })),
});
export type JiraSetSprintResult = typeof JiraSetSprintResult.Type;

/** Set or clear an issue's story points as the caller, with their personal token. */
export const JiraSetStoryPointsInput = Schema.Struct({
  ...JiraIssueKey.fields,
  /** Null clears the estimate. */
  storyPoints: Schema.NullOr(
    Schema.Number.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(JIRA_STORY_POINTS_MAX),
    ),
  ),
});
export type JiraSetStoryPointsInput = typeof JiraSetStoryPointsInput.Type;

/**
 * Break an issue into work packages: the server starts a thread in `projectId` whose agent reads
 * the issue and the repository and proposes child issues for the caller to approve. Refused when
 * the caller has no personal token, since only they could approve what it proposes.
 */
export const JiraBreakdownStartInput = Schema.Struct({
  ...JiraIssueKey.fields,
  projectId: ProjectId,
});
export type JiraBreakdownStartInput = typeof JiraBreakdownStartInput.Type;

export const JiraBreakdownStartResult = Schema.Struct({
  threadId: ThreadId,
  /** False when a breakdown of the issue was already running and this returned its thread. */
  started: Schema.Boolean,
});
export type JiraBreakdownStartResult = typeof JiraBreakdownStartResult.Type;
