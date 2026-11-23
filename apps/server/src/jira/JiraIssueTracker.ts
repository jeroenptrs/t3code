/**
 * Jira as a tracker-neutral issue tracker. A scope is a project key (`ABC`) and an issue key is
 * Jira's own (`ABC-123`), on the reader identity's site. A call made for a signed-in user who
 * stored a personal token reads as that user, and only such a call comments or changes state.
 * Every other call reads as the reader identity and writes nothing.
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
import * as Layer from "effect/Layer";

import { buildIssueListJql } from "./issueListJql.ts";
import {
  summaryFields,
  toComment,
  toDescription,
  toIsoDateTime,
  toIssueSummary,
  toJiraUser,
  toTransition,
} from "./issueMapping.ts";
import { JiraActingUser } from "./JiraActingUser.ts";
import * as JiraApi from "./JiraApi.ts";
import * as JiraIdentities from "./JiraIdentities.ts";
import * as JiraReadCache from "./JiraReadCache.ts";
import * as JiraService from "./JiraService.ts";
import * as JiraUserCredentials from "./JiraUserCredentials.ts";

export const KIND = IssueTrackerKind.make(JIRA_ISSUE_TRACKER_KIND);

/** Comments and state changes are the writes; `setState` has no capability flag of its own. */
const CAPABILITIES: IssueCapabilities = {
  create: false,
  edit: false,
  comment: true,
  labels: false,
  assignees: false,
  reactions: false,
  templates: false,
  linkedPullRequests: false,
  events: false,
  search: true,
};

/** A write goes out with the signed-in user's own token, so only its holder may write. */
const viewerPermissions = (personal: boolean): IssueViewerPermissions => ({
  setState: personal,
  comment: personal,
  edit: false,
  labels: false,
  assignees: false,
});

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

const transitionState = (transition: JiraApi.JiraRawTransition): IssueState => {
  const { toStatus, toStatusCategory } = toTransition(transition);
  return toIssueState(toStatus, toStatusCategory);
};

/** The current state, then each status a transition Jira offers leads to, once per name. */
function toIssueStates(
  current: IssueState,
  offered: ReadonlyArray<JiraApi.JiraRawTransition>,
): ReadonlyArray<IssueState> {
  const states = [current, ...offered.map(transitionState)];
  return states.filter(
    (state, index) => states.findIndex((other) => other.name === state.name) === index,
  );
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
    detail: "Jira has no issue by that key, or the account reading it cannot see it.",
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
  const service = yield* JiraService.JiraService;
  const site = reader.site;

  /** Who this call reads as: the acting user where they stored a token, else the reader. */
  const reading = (operation: string) =>
    Effect.flatMap(JiraActingUser, (userId) =>
      service.readAs(site, { actingUserId: userId ?? undefined }),
    ).pipe(Effect.mapError(toTrackerError(operation)));

  /** A write needs an acting user with a personal token: a service identity never writes. */
  const writing = Effect.fnUntraced(function* (operation: string) {
    const { identity, guard } = yield* reading(operation);
    if (identity.personal === undefined) {
      return yield* toTrackerError(operation)(JiraService.personalTokenRequired);
    }
    return { identity, guard, userId: identity.personal.userId };
  });

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

    // The token is ignored: the reader identity is the connection, and it is never stored here.
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

    getViewer: Effect.fn("JiraIssueTracker.getViewer")(function* () {
      const { myself } = yield* reading("getViewer");
      const me = yield* myself.pipe(Effect.mapError(toTrackerError("getViewer")));
      return viewerName(me, reader.name);
    }),

    listIssues: Effect.fn("JiraIssueTracker.listIssues")(function* (input) {
      const { identity, guard } = yield* reading("listIssues");
      const page = yield* jira
        .searchJql(identity, {
          jql: buildIssueListJql(input),
          fields: ISSUE_FIELDS,
          maxResults: input.limit,
          nextPageToken: input.cursor,
        })
        .pipe(guard, Effect.mapError(toTrackerError("listIssues")));
      return {
        items: (page.issues ?? []).map((issue) => toTrackerIssueSummary(issue, site)),
        nextCursor: page.nextPageToken || null,
      };
    }),

    getIssue: Effect.fn("JiraIssueTracker.getIssue")(function* (input) {
      const key = yield* requireKey("getIssue", input.key);
      const { identity, guard, myself } = yield* reading("getIssue");
      const personal = identity.personal !== undefined;
      const [issue, comments, transitions, me] = yield* Effect.all(
        [
          jira.getIssue(identity, key, { fields: [...ISSUE_FIELDS, "description"] }),
          jira.getComments(identity, key, { maxResults: COMMENTS_PAGE, orderBy: "-created" }),
          jira.getTransitions(identity, key),
          // The reader identity is a server account, not the person looking at the issue.
          personal ? myself : Effect.succeed(null),
        ],
        { concurrency: 4 },
      ).pipe(guard, Effect.mapError(toTrackerError("getIssue")));
      const count = comments.total ?? (comments.comments ?? []).length;
      const summary = toTrackerIssueSummary(issue, site, count);
      return {
        ...summary,
        body: toDescription(issue) ?? "",
        viewer: me === null ? null : viewerName(me, reader.name),
        viewerPermissions: viewerPermissions(personal),
        states: toIssueStates(summary.state, transitions),
        // A key that moved projects answers under its new key, which is what the links name.
        comments: toComments(comments, site, issue.key),
        commentsCursor: olderCommentsCursor(comments, 0),
        events: [],
        linkedPullRequests: [],
      };
    }),

    getIssueLink: Effect.fn("JiraIssueTracker.getIssueLink")(function* (input) {
      const key = yield* requireKey("getIssueLink", input.key);
      const { identity, guard } = yield* reading("getIssueLink");
      const issue = yield* jira
        .getIssue(identity, key, { fields: ISSUE_FIELDS })
        .pipe(guard, Effect.mapError(toTrackerError("getIssueLink")));
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
      const { identity, guard } = yield* reading("getComments");
      const page = yield* jira
        .getComments(identity, key, { maxResults: COMMENTS_PAGE, orderBy: "-created", startAt })
        .pipe(guard, Effect.mapError(toTrackerError("getComments")));
      return {
        comments: toComments(page, site, key),
        nextCursor: olderCommentsCursor(page, startAt),
      };
    }),

    comment: Effect.fn("JiraIssueTracker.comment")(function* (input) {
      const key = yield* requireKey("comment", input.key);
      const { userId } = yield* writing("comment");
      yield* service
        .addComment(userId, { site, key, body: input.body })
        .pipe(Effect.mapError(toTrackerError("comment")));
    }),

    setState: Effect.fn("JiraIssueTracker.setState")(function* (input) {
      const key = yield* requireKey("setState", input.key);
      const { identity, guard, userId } = yield* writing("setState");
      const offered = yield* jira
        .getTransitions(identity, key)
        .pipe(guard, Effect.mapError(toTrackerError("setState")));
      const wanted = input.state.trim();
      const [transition, ...others] = offered.filter(
        (candidate) => transitionState(candidate).name === wanted,
      );
      if (transition === undefined || others.length > 0) {
        return yield* new IssueTrackerError({
          tracker: KIND,
          operation: "setState",
          reason: "failed",
          detail:
            transition === undefined
              ? `Jira offers you no transition that moves ${key} to "${wanted}".`
              : `More than one Jira transition moves ${key} to "${wanted}". Take the one you want in Jira.`,
        });
      }
      yield* service
        .transitionIssue(userId, { site, key, transitionId: transition.id })
        .pipe(Effect.mapError(toTrackerError("setState")));
    }),
  };
  return api;
});

/**
 * What the tracker is built from. These are the instances the Jira services build, by layer
 * memoization, so a comment posted here is one a Jira watch knows T3 Code posted.
 */
export const layerDependencies = JiraService.layer.pipe(
  Layer.provideMerge(JiraUserCredentials.layer),
  Layer.provideMerge(JiraApi.layer),
  Layer.provide(JiraReadCache.layer),
  Layer.provideMerge(JiraIdentities.layer),
);

/** The Jira tracker on a server with Jira identities; none at all on a server without. */
export const registered: Effect.Effect<
  ReadonlyArray<StandaloneIssueTrackerApi>,
  never,
  JiraApi.JiraApi | JiraIdentities.JiraIdentities | JiraService.JiraService
> = Effect.gen(function* () {
  const identities = yield* JiraIdentities.JiraIdentities;
  if (!identities.configured) return [];
  // `configured` is what makes the reader exist.
  return [yield* make(yield* Effect.orDie(identities.reader))];
});
