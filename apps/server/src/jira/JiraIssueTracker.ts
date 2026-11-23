/**
 * Jira as a tracker-neutral issue tracker, read-only. A scope is a project key (`ABC`) and an
 * issue key is Jira's own (`ABC-123`). Every read is made as the reader identity on the reader's
 * site, so there is no credential to save and no other site to reach.
 */
import {
  IssueTrackerKind,
  JIRA_ISSUE_KEY_PATTERN,
  JIRA_ISSUE_TRACKER_KIND,
  parseJiraIssueUrl,
  type IssueActor,
  type IssueCapabilities,
  type IssueComment,
  type IssueState,
  type IssueViewerPermissions,
  type JiraError,
  type JiraStatusCategory,
  type JiraUser,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type StandaloneIssueTrackerApi,
  type TrackerIssueSummary,
} from "@t3tools/source-control-core/server/IssueTracker";
import * as Effect from "effect/Effect";

import { buildIssueListJql } from "./issueListJql.ts";
import {
  summaryFields,
  toComment,
  toDescription,
  toIsoDateTime,
  toIssueSummary,
  toJiraUser,
} from "./issueMapping.ts";
import * as JiraApi from "./JiraApi.ts";
import * as JiraIdentities from "./JiraIdentities.ts";

export const KIND = IssueTrackerKind.make(JIRA_ISSUE_TRACKER_KIND);

/** Search is the one thing beyond reading; writes wait for the proposal approval gate. */
const CAPABILITIES: IssueCapabilities = {
  create: false,
  edit: false,
  comment: false,
  labels: false,
  assignees: false,
  reactions: false,
  templates: false,
  linkedPullRequests: false,
  events: false,
  search: true,
};

const VIEWER_PERMISSIONS: IssueViewerPermissions = {
  setState: false,
  comment: false,
  edit: false,
  labels: false,
  assignees: false,
};

const NO_CUSTOM_FIELDS = { sprint: null, storyPoints: null };
const ISSUE_FIELDS = [...summaryFields(NO_CUSTOM_FIELDS), "created", "reporter", "resolutiondate"];
const COMMENTS_PAGE = 50;
const PROJECTS_PAGE = 100;
/** A site with more projects than this offers the first ones by key; the rest cannot be bound. */
const MAX_PROJECTS = 1_000;

const FALLBACK_STATE_NAME: Record<JiraStatusCategory, string> = {
  todo: "To Do",
  "in-progress": "In Progress",
  done: "Done",
};

/** Workflows differ per project, so only the status category decides open or closed. */
export function toIssueState(status: string, category: JiraStatusCategory): IssueState {
  return {
    category: category === "done" ? "closed" : "open",
    name: status.trim() || FALLBACK_STATE_NAME[category],
  };
}

/** The login is the display name: it is what people read and what JQL accepts for an assignee. */
function toActor(user: JiraUser): IssueActor {
  return {
    login: user.displayName.trim() || user.accountId,
    name: null,
    avatarUrl: user.avatarUrl,
  };
}

const EPOCH = "1970-01-01T00:00:00.000Z";

/** One raw issue as a neutral row. `site` is the lowercase host the issue was read from. */
export function toTrackerIssueSummary(
  issue: JiraApi.JiraRawIssue,
  site: string,
  commentCount = 0,
): TrackerIssueSummary {
  const row = toIssueSummary(issue, { site, fieldIds: NO_CUSTOM_FIELDS });
  const fields = issue.fields ?? {};
  const createdAt = toIsoDateTime(fields.created) ?? row.updated ?? EPOCH;
  const reporter = toJiraUser(fields.reporter);
  return {
    key: row.key,
    displayKey: row.key,
    title: row.summary.trim() || row.key,
    url: row.url,
    author: reporter === null ? null : toActor(reporter),
    state: toIssueState(row.status, row.statusCategory),
    createdAt,
    updatedAt: row.updated ?? createdAt,
    closedAt: row.statusCategory === "done" ? toIsoDateTime(fields.resolutiondate) : null,
    assignees: row.assignee === null ? [] : [toActor(row.assignee)],
    labels: row.labels.map((label) => ({ name: label.trim(), color: null })),
    commentCount,
  };
}

/** Jira's newest-first page as the conversation reads it: oldest first. */
function toComments(
  page: JiraApi.JiraRawComments,
  site: string,
  key: string,
): ReadonlyArray<IssueComment> {
  return (page.comments ?? [])
    .flatMap((raw) => {
      const comment = toComment(raw);
      if (comment === null) return [];
      return [
        {
          id: comment.id,
          author: comment.author === null ? null : toActor(comment.author),
          body: comment.body,
          createdAt: comment.created,
          url: `https://${site}/browse/${key}?focusedCommentId=${encodeURIComponent(comment.id)}`,
        },
      ];
    })
    .toReversed();
}

/** Where the comments older than the `read` newest ones start, or null once all were read. */
function olderCommentsCursor(page: JiraApi.JiraRawComments, startAt: number): string | null {
  const read = startAt + (page.comments ?? []).length;
  return (page.comments ?? []).length > 0 && (page.total ?? read) > read ? String(read) : null;
}

const REASONS: Record<JiraError["reason"], IssueTrackerError["reason"]> = {
  "not-configured": "missing-tool",
  "personal-token-required": "unauthenticated",
  unauthorized: "unauthenticated",
  forbidden: "failed",
  "not-found": "not-found",
  invalid: "failed",
  unavailable: "failed",
};

const toTrackerError = (operation: string) => (error: JiraError) =>
  new IssueTrackerError({
    tracker: KIND,
    operation,
    reason: REASONS[error.reason],
    detail: error.message,
    cause: error,
  });

const notFound = (operation: string) =>
  new IssueTrackerError({
    tracker: KIND,
    operation,
    reason: "not-found",
    detail: "Jira has no issue by that key, or the reader identity cannot see it.",
  });

const requireKey = (operation: string, key: string) => {
  const normalized = key.trim().toUpperCase();
  return JIRA_ISSUE_KEY_PATTERN.test(normalized)
    ? Effect.succeed(normalized)
    : Effect.fail(notFound(operation));
};

const viewerName = (user: JiraApi.JiraRawUser, fallback: string) =>
  user.displayName?.trim() || user.accountId?.trim() || fallback;

const make = Effect.fn("JiraIssueTracker.make")(function* (
  reader: JiraIdentities.JiraIdentities["Service"]["services"][number],
) {
  const jira = yield* JiraApi.JiraApi;
  const site = reader.site;

  const projects = Effect.gen(function* () {
    const all: Array<JiraApi.JiraRawProject> = [];
    for (let startAt = 0; startAt < MAX_PROJECTS; startAt += PROJECTS_PAGE) {
      const page = yield* jira.searchProjects(reader, { startAt, maxResults: PROJECTS_PAGE });
      all.push(...page.projects);
      if (page.isLast || page.projects.length === 0) break;
    }
    return all;
  });

  const api: StandaloneIssueTrackerApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    standalone: {
      tracker: KIND,
      displayName: "Jira",
      host: site,
      scopeNoun: "project",
      credential: { label: "Server identity", helpUrl: null },
      serverManaged: true,
    },
    parseIssueUrl: (url) => parseJiraIssueUrl(url, site),

    // The token is ignored: the reader identity is the credential, and it is never stored here.
    probeCredential: () =>
      Effect.all([jira.myself(reader), projects], { concurrency: 2 }).pipe(
        Effect.map(([me, found]) => ({
          account: viewerName(me, reader.name),
          workspace: site,
          scopes: found.flatMap((project) => {
            const key = project.key.trim();
            return key.length === 0 ? [] : [{ key, name: project.name?.trim() || key }];
          }),
        })),
        Effect.mapError(toTrackerError("probeCredential")),
      ),

    getViewer: () =>
      jira.myself(reader).pipe(
        Effect.map((me) => viewerName(me, reader.name)),
        Effect.mapError(toTrackerError("getViewer")),
      ),

    listIssues: (input) =>
      jira
        .searchJql(reader, {
          jql: buildIssueListJql(input),
          fields: ISSUE_FIELDS,
          maxResults: input.limit,
          nextPageToken: input.cursor,
        })
        .pipe(
          Effect.map((page) => ({
            items: (page.issues ?? []).map((issue) => toTrackerIssueSummary(issue, site)),
            nextCursor: page.nextPageToken || null,
          })),
          Effect.mapError(toTrackerError("listIssues")),
          Effect.withSpan("JiraIssueTracker.listIssues"),
        ),

    getIssue: Effect.fn("JiraIssueTracker.getIssue")(function* (input) {
      const key = yield* requireKey("getIssue", input.key);
      const [issue, comments] = yield* Effect.all(
        [
          jira.getIssue(reader, key, { fields: [...ISSUE_FIELDS, "description"] }),
          jira.getComments(reader, key, { maxResults: COMMENTS_PAGE, orderBy: "-created" }),
        ],
        { concurrency: 2 },
      ).pipe(Effect.mapError(toTrackerError("getIssue")));
      const count = comments.total ?? (comments.comments ?? []).length;
      return {
        ...toTrackerIssueSummary(issue, site, count),
        body: toDescription(issue) ?? "",
        viewer: null,
        viewerPermissions: VIEWER_PERMISSIONS,
        // Empty until writes exist, so no surface offers a state change.
        states: [],
        // A key that moved projects answers under its new key, which is what the links name.
        comments: toComments(comments, site, issue.key),
        commentsCursor: olderCommentsCursor(comments, 0),
        events: [],
        linkedPullRequests: [],
      };
    }),

    getIssueLink: Effect.fn("JiraIssueTracker.getIssueLink")(function* (input) {
      const key = yield* requireKey("getIssueLink", input.key);
      const issue = yield* jira
        .getIssue(reader, key, { fields: ISSUE_FIELDS })
        .pipe(Effect.mapError(toTrackerError("getIssueLink")));
      const { title, url, displayKey } = toTrackerIssueSummary(issue, site);
      return { title, url, displayKey };
    }),

    getComments: Effect.fn("JiraIssueTracker.getComments")(function* (input) {
      const key = yield* requireKey("getComments", input.key);
      const startAt = /^\d{1,9}$/.test(input.cursor) ? Number(input.cursor) : null;
      if (startAt === null) {
        return yield* new IssueTrackerError({
          tracker: KIND,
          operation: "getComments",
          reason: "failed",
          detail: "This is not a comment cursor Jira handed out.",
        });
      }
      const page = yield* jira
        .getComments(reader, key, { maxResults: COMMENTS_PAGE, orderBy: "-created", startAt })
        .pipe(Effect.mapError(toTrackerError("getComments")));
      return {
        comments: toComments(page, site, key),
        nextCursor: olderCommentsCursor(page, startAt),
      };
    }),
  };
  return api;
});

/** The Jira tracker on a server with Jira identities; none at all on a server without. */
export const registered: Effect.Effect<
  ReadonlyArray<StandaloneIssueTrackerApi>,
  never,
  JiraApi.JiraApi | JiraIdentities.JiraIdentities
> = Effect.gen(function* () {
  const identities = yield* JiraIdentities.JiraIdentities;
  if (!identities.configured) return [];
  // `configured` is what makes the reader exist.
  return [yield* make(yield* Effect.orDie(identities.reader))];
});
