import {
  JiraError,
  JiraLinkedThread,
  PullRequestState,
  ThreadId,
  ThreadJiraIssueSnapshot,
  ThreadJiraIssueWatch,
  type JiraIssueKey,
  type JiraLinkedPullRequest,
} from "@t3tools/contracts";
import { normalizeThreadPullRequestKey } from "../sourceControl/threadPullRequests.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { jiraIssueKeyFromBranch, parseJiraIssueKeysFrom } from "./issueKeys.ts";

const decodeLinkedThreads = Schema.decodeUnknownEffect(Schema.Array(JiraLinkedThread));
const decodeThreadBranches = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      branch: Schema.String,
      linkedKeys: Schema.fromJsonString(Schema.Array(Schema.String)),
    }),
  ),
);
const decodeActiveLinks = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      site: Schema.String,
      key: Schema.String,
      snapshot: Schema.NullOr(Schema.fromJsonString(ThreadJiraIssueSnapshot)),
      watch: Schema.NullOr(Schema.fromJsonString(ThreadJiraIssueWatch)),
    }),
  ),
);
const decodeRemoteLinkRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      title: Schema.String,
      site: Schema.String,
      key: Schema.String,
    }),
  ),
);
const isPullRequestState = Schema.is(PullRequestState);

const localReadFailed = (what: string) => () =>
  new JiraError({ reason: "unavailable", message: `Could not load ${what}.` });

/** Threads linked to the issue, most recently updated first; dismissed links and deleted threads are left out. */
export const listJiraIssueLinkedThreads = Effect.fn("listJiraIssueLinkedThreads")(
  function* (input: JiraIssueKey) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      SELECT t.thread_id AS id, t.project_id AS "projectId", t.title,
        t.archived_at AS "archivedAt", link.source
      FROM fork_projection_thread_jira_issues AS link
      JOIN orchestration_v2_projection_threads AS t ON t.thread_id = link.thread_id
      WHERE link.site = ${input.site.toLowerCase()}
        AND link.issue_key = ${input.key}
        AND link.source != 'branch-dismissed'
        AND t.deleted_at IS NULL
      ORDER BY t.updated_at DESC, t.thread_id ASC
    `;
    return yield* decodeLinkedThreads(rows);
  },
  Effect.mapError(localReadFailed("the threads linked to this issue")),
);

/**
 * Branches of threads that are neither archived nor deleted, one thread or all of them, each with
 * the keys it already links on `site`. Dismissed links count, so the branch detector skips them.
 */
export const listThreadBranchesForJira = Effect.fn("listThreadBranchesForJira")(
  function* (site: string, threadId: ThreadId | null) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      SELECT t.thread_id AS "threadId",
        json_extract(t.payload_json, '$.branch') AS branch,
        (
          SELECT json_group_array(link.issue_key)
          FROM fork_projection_thread_jira_issues AS link
          WHERE link.thread_id = t.thread_id AND link.site = ${site}
        ) AS "linkedKeys"
      FROM orchestration_v2_projection_threads AS t
      WHERE t.deleted_at IS NULL
        AND t.archived_at IS NULL
        AND json_extract(t.payload_json, '$.branch') IS NOT NULL${
          threadId === null ? sql`` : sql` AND t.thread_id = ${threadId}`
        }
    `;
    return yield* decodeThreadBranches(rows);
  },
  Effect.mapError(localReadFailed("thread branches")),
);

/** Visible links on threads that are neither archived nor deleted, with their snapshot and watch. */
export const listActiveThreadJiraIssueLinks = Effect.fn("listActiveThreadJiraIssueLinks")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      SELECT link.thread_id AS "threadId", link.site, link.issue_key AS key,
        link.snapshot_json AS snapshot, link.watch_json AS watch
      FROM fork_projection_thread_jira_issues AS link
      JOIN orchestration_v2_projection_threads AS t ON t.thread_id = link.thread_id
      WHERE link.source != 'branch-dismissed'
        AND t.deleted_at IS NULL
        AND t.archived_at IS NULL
    `;
    return yield* decodeActiveLinks(rows);
  },
  Effect.mapError(localReadFailed("linked Jira issues")),
);

/** Visible links on threads that are neither archived nor deleted, with the thread's title. */
export const listActiveThreadJiraRemoteLinks = Effect.fn("listActiveThreadJiraRemoteLinks")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      SELECT link.thread_id AS "threadId", t.title, link.site, link.issue_key AS key
      FROM fork_projection_thread_jira_issues AS link
      JOIN orchestration_v2_projection_threads AS t ON t.thread_id = link.thread_id
      WHERE link.source != 'branch-dismissed'
        AND t.deleted_at IS NULL
        AND t.archived_at IS NULL
    `;
    return yield* decodeRemoteLinkRows(rows);
  },
  Effect.mapError(localReadFailed("linked Jira issues")),
);

interface PullRequestLinkRow {
  readonly threadId: ThreadId;
  readonly host: string | null;
  readonly repository: string | null;
  readonly number: number | null;
  readonly url: string | null;
  readonly title: string | null;
  readonly headBranch: string | null;
  readonly state: string | null;
}

/**
 * Pull requests T3 already tracks whose head branch or title names the issue, one entry per
 * pull request with every thread that links it. SQL narrows to links whose title or branch
 * contains the key, case-insensitively; the exact key parse runs here. Only synced links carry
 * a title and branch, and pull request descriptions are not stored, so neither is searched.
 */
export const listJiraIssuePullRequests = Effect.fn("listJiraIssuePullRequests")(
  function* (input: JiraIssueKey) {
    const sql = yield* SqlClient.SqlClient;
    // A `_` in a project key is a LIKE wildcard, which only widens this narrowing; the exact
    // parse below decides.
    const pattern = `%${input.key}%`;
    const rows = yield* sql<PullRequestLinkRow>`
      SELECT t.thread_id AS "threadId",
        json_extract(link.value, '$.host') AS host,
        json_extract(link.value, '$.repository') AS repository,
        json_extract(link.value, '$.number') AS number,
        json_extract(link.value, '$.url') AS url,
        json_extract(link.value, '$.snapshot.title') AS title,
        json_extract(link.value, '$.snapshot.headBranch') AS "headBranch",
        json_extract(link.value, '$.snapshot.state') AS state
      FROM orchestration_v2_projection_threads AS t
      JOIN json_each(t.payload_json, '$.pullRequests') AS link
      WHERE t.deleted_at IS NULL
        AND json_extract(link.value, '$.source') != 'stack-dismissed'
        AND (
          json_extract(link.value, '$.snapshot.title') LIKE ${pattern}
          OR json_extract(link.value, '$.snapshot.headBranch') LIKE ${pattern}
        )
      ORDER BY t.updated_at DESC, t.thread_id ASC
    `;
    return groupPullRequests(rows, input.key);
  },
  Effect.mapError(localReadFailed("the pull requests for this issue")),
);

const groupPullRequests = (
  rows: ReadonlyArray<PullRequestLinkRow>,
  issueKey: string,
): Array<JiraLinkedPullRequest> => {
  const byKey = new Map<string, JiraLinkedPullRequest & { threadIds: Array<ThreadId> }>();
  for (const row of rows) {
    if (
      row.host === null ||
      row.repository === null ||
      row.number === null ||
      row.url === null ||
      row.title === null
    ) {
      continue;
    }
    const mentions =
      (row.headBranch !== null && jiraIssueKeyFromBranch(row.headBranch) === issueKey) ||
      parseJiraIssueKeysFrom([row.title]).includes(issueKey);
    if (!mentions) continue;
    const key = normalizeThreadPullRequestKey({
      host: row.host,
      repository: row.repository,
      number: row.number,
      url: row.url,
    });
    const id = `${key.host}\u0000${key.repository}\u0000${key.number}`;
    const existing = byKey.get(id);
    if (existing !== undefined) {
      if (!existing.threadIds.includes(row.threadId)) existing.threadIds.push(row.threadId);
      continue;
    }
    byKey.set(id, {
      host: row.host,
      repository: row.repository,
      number: row.number,
      url: row.url,
      title: row.title,
      state: isPullRequestState(row.state) ? row.state : null,
      headBranch: row.headBranch,
      threadIds: [row.threadId],
    });
  }
  return [...byKey.values()];
};
