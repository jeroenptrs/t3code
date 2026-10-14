import type { JiraComment, ThreadJiraIssueWatch } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { JIRA_WATCH_WAKE_LIMIT, evaluateJiraWatch, jiraWatchMessage } from "./jiraWatch.ts";

const STARTED = "2026-10-14T10:00:00.000Z";
const READER = "account-bot";

const watch = (overrides: Partial<ThreadJiraIssueWatch> = {}): ThreadJiraIssueWatch => ({
  startedAt: STARTED,
  updatedThrough: "2026-10-14T10:00:00.000Z",
  statusCategory: "in-progress",
  assigneeAccountId: "account-ada",
  commentsThrough: STARTED,
  wakes: 0,
  ...overrides,
});

const user = (accountId: string, displayName: string) => ({
  accountId,
  displayName,
  avatarUrl: null,
});

const comment = (id: string, created: string, author: string, body = `Comment ${id}`) =>
  ({
    id,
    author: user(author, author === READER ? "T3 Bot" : `Person ${author}`),
    body,
    created,
    updated: null,
  }) satisfies JiraComment;

const issue = (overrides: Partial<Parameters<typeof evaluateJiraWatch>[1]["issue"]> = {}) => ({
  status: "In Progress",
  statusCategory: "in-progress" as const,
  assignee: user("account-ada", "Ada"),
  updated: "2026-10-14T10:05:00.000Z",
  ...overrides,
});

describe("evaluateJiraWatch", () => {
  it("wakes on comments by others since the last read and moves past the reader's own", () => {
    const report = evaluateJiraWatch(watch(), {
      issue: issue(),
      comments: [
        comment("4", "2026-10-14T10:04:00.000Z", READER),
        comment("3", "2026-10-14T10:03:00.000Z", "account-bob"),
        comment("2", "2026-10-14T10:02:00.000Z", "account-ada"),
        comment("1", "2026-10-14T09:59:00.000Z", "account-bob"),
      ],
      readerAccountId: READER,
    });
    expect(report.changes).toEqual([
      {
        kind: "comments",
        comments: [
          comment("2", "2026-10-14T10:02:00.000Z", "account-ada"),
          comment("3", "2026-10-14T10:03:00.000Z", "account-bob"),
        ],
      },
    ]);
    expect(report.next).toEqual(
      watch({
        updatedThrough: "2026-10-14T10:05:00.000Z",
        commentsThrough: "2026-10-14T10:04:00.000Z",
        wakes: 1,
      }),
    );
    expect(report.exhausted).toBe(false);
  });

  it("records an edit that changed nothing it watches without waking", () => {
    const report = evaluateJiraWatch(watch(), {
      issue: issue(),
      comments: [comment("1", "2026-10-14T10:04:00.000Z", READER)],
      readerAccountId: READER,
    });
    expect(report.changes).toEqual([]);
    expect(report.next.commentsThrough).toBe("2026-10-14T10:04:00.000Z");
    expect(report.next.updatedThrough).toBe("2026-10-14T10:05:00.000Z");
  });

  it("wakes on a status category or assignee change and resets the comment count", () => {
    const report = evaluateJiraWatch(watch({ wakes: 7 }), {
      issue: issue({ status: "Shipped", statusCategory: "done", assignee: null }),
      comments: [comment("1", "2026-10-14T10:04:00.000Z", "account-bob")],
      readerAccountId: READER,
    });
    expect(report.changes.map((change) => change.kind)).toEqual(["status", "assignee", "comments"]);
    expect(report.next).toMatchObject({
      statusCategory: "done",
      assigneeAccountId: null,
      wakes: 0,
    });
    const message = jiraWatchMessage({
      key: "ABC-1",
      summary: "Ship it",
      url: "https://acme.atlassian.net/browse/ABC-1",
      report,
    });
    expect(message.text).toContain("Status moved from In Progress to Done");
    expect(message.text).toContain("now unassigned");
    expect(message.text).toContain('Person account-bob: "Comment 1"');
    expect(message.text).toContain("unwatch_jira_issue");
    expect(message.notification).toEqual({
      source: { kind: "monitor" },
      outcome: "completed",
      summary: "ABC-1: status changed, assignee changed, new comments",
    });
  });

  it("takes the assignee and a missing status from the first read without waking", () => {
    const report = evaluateJiraWatch(
      watch({ updatedThrough: null, statusCategory: null, assigneeAccountId: null }),
      { issue: issue(), comments: [], readerAccountId: READER },
    );
    expect(report.changes).toEqual([]);
    expect(report.next).toMatchObject({
      statusCategory: "in-progress",
      assigneeAccountId: "account-ada",
    });
    // A status the link's snapshot already knew is compared from the start.
    const moved = evaluateJiraWatch(watch({ updatedThrough: null, assigneeAccountId: null }), {
      issue: issue({ statusCategory: "todo", status: "Reopened" }),
      comments: [],
      readerAccountId: READER,
    });
    expect(moved.changes.map((change) => change.kind)).toEqual(["status"]);
  });

  it("stops after the limit of comment-only wakes in a row", () => {
    const report = evaluateJiraWatch(watch({ wakes: JIRA_WATCH_WAKE_LIMIT - 1 }), {
      issue: issue(),
      comments: [comment("1", "2026-10-14T10:04:00.000Z", "account-bob")],
      readerAccountId: READER,
    });
    expect(report.exhausted).toBe(true);
    const message = jiraWatchMessage({
      key: "ABC-1",
      summary: "Ship it",
      url: "https://acme.atlassian.net/browse/ABC-1",
      report,
    });
    expect(message.text).toContain("stopped watching");
    expect(message.notification.summary).toBe("ABC-1: new comments, stopped watching");
  });
});
