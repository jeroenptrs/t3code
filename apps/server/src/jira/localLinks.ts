import {
  JiraError,
  JiraLinkedThread,
  PullRequestState,
  type JiraIssueKey,
  type JiraLinkedPullRequest,
  type ThreadId,
} from "@t3tools/contracts";
import { normalizeThreadPullRequestKey } from "@t3tools/shared/threadPullRequests";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { jiraIssueKeyFromBranch, parseJiraIssueKeysFrom } from "./issueKeys.ts";

const decodeLinkedThreads = Schema.decodeUnknownEffect(Schema.Array(JiraLinkedThread));
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
    // Issue keys are `[A-Z][A-Z0-9]+-[0-9]+`, so the key carries no LIKE wildcards.
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
