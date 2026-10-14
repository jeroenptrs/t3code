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
   * `not-configured`: no identity; `unauthorized`/`forbidden`: Jira refused the identity;
   * `not-found`: the issue or filter does not exist or is not visible; `invalid`: the request or
   * JQL was rejected; `unavailable`: Jira could not be reached or failed.
   */
  reason: Schema.Literals([
    "not-configured",
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

export const ThreadJiraIssueLink = Schema.Struct({
  ...JiraIssueKey.fields,
  source: ThreadJiraIssueLinkSource,
  linkedAt: IsoDateTime,
  /** Portal user who linked it; absent for the server, agents and users before attribution. */
  linkedByUserId: Schema.optional(AuthUserId),
  /** Null until the sync sweep first reads the issue. */
  snapshot: Schema.NullOr(ThreadJiraIssueSnapshot),
});
export type ThreadJiraIssueLink = typeof ThreadJiraIssueLink.Type;
