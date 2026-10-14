import type { JiraComment, ThreadJiraIssueWatch } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { JIRA_WATCH_WAKE_LIMIT, evaluateJiraWatch, jiraWatchMessage } from "./jiraWatch.ts";

const STARTED = "2026-10-14T10:00:00.000Z";
const READER = "account-bot";
const AGENT = "account-agent";
/** What a read learns about T3 Code's own comments: none posted, the reader's account. */
const own = { ownAccountIds: new Set([READER]), ownCommentIds: new Set<string>() };

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
      ...own,
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
        // The issue's own last update, which every comment read is behind.
        commentsThrough: "2026-10-14T10:05:00.000Z",
        wakes: 1,
      }),
    );
    expect(report.exhausted).toBe(false);
  });

  it("records an edit that changed nothing it watches without waking", () => {
    const report = evaluateJiraWatch(watch(), {
      issue: issue(),
      comments: [comment("1", "2026-10-14T10:04:00.000Z", READER)],
      ...own,
    });
    expect(report.changes).toEqual([]);
    expect(report.next.commentsThrough).toBe("2026-10-14T10:05:00.000Z");
    expect(report.next.updatedThrough).toBe("2026-10-14T10:05:00.000Z");
  });

  it("wakes on a status category or assignee change and resets the comment count", () => {
    const report = evaluateJiraWatch(watch({ wakes: 7 }), {
      issue: issue({ status: "Shipped", statusCategory: "done", assignee: null }),
      comments: [comment("1", "2026-10-14T10:04:00.000Z", "account-bob")],
      ...own,
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

  it("takes the status and assignee from the first read without waking", () => {
    const report = evaluateJiraWatch(
      watch({ updatedThrough: null, statusCategory: null, assigneeAccountId: null }),
      { issue: issue(), comments: [], ...own },
    );
    expect(report.changes).toEqual([]);
    expect(report.next).toMatchObject({
      statusCategory: "in-progress",
      assigneeAccountId: "account-ada",
    });
    // A status recorded before the first read, as older watches took from the link's snapshot,
    // is no baseline: the move may have happened before the watch started.
    const moved = evaluateJiraWatch(watch({ updatedThrough: null, assigneeAccountId: null }), {
      issue: issue({ statusCategory: "todo", status: "Reopened" }),
      comments: [],
      ...own,
    });
    expect(moved.changes).toEqual([]);
    expect(moved.next.statusCategory).toBe("todo");
  });

  it("never counts comments by T3 Code's own accounts or comments it posted", () => {
    const report = evaluateJiraWatch(watch(), {
      issue: issue(),
      comments: [
        comment("4", "2026-10-14T10:04:00.000Z", "account-bob"),
        comment("3", "2026-10-14T10:03:00.000Z", "account-ada"),
        comment("2", "2026-10-14T10:02:00.000Z", AGENT),
        comment("1", "2026-10-14T10:01:00.000Z", READER),
      ],
      ownAccountIds: new Set([READER, AGENT]),
      // Ada's comment went out through T3 Code, from her own token.
      ownCommentIds: new Set(["3"]),
    });
    expect(report.changes).toEqual([
      { kind: "comments", comments: [comment("4", "2026-10-14T10:04:00.000Z", "account-bob")] },
    ]);
    expect(report.next.commentsThrough).toBe("2026-10-14T10:05:00.000Z");
  });

  it("counts comments from just before a watch started, then follows Jira's clock", () => {
    // T3 Code's clock runs ahead of Jira's: a comment made as the watch started reads as older.
    const started = watch({
      updatedThrough: null,
      statusCategory: null,
      assigneeAccountId: null,
      commentsThrough: STARTED,
    });
    const first = evaluateJiraWatch(started, {
      issue: issue({ updated: "2026-10-14T09:59:30.000Z" }),
      comments: [
        comment("2", "2026-10-14T09:59:30.000Z", "account-bob"),
        comment("1", "2026-10-14T09:57:00.000Z", "account-bob"),
      ],
      ...own,
    });
    expect(first.changes).toEqual([
      { kind: "comments", comments: [comment("2", "2026-10-14T09:59:30.000Z", "account-bob")] },
    ]);
    // Behind every comment read, by Jira's time and not T3 Code's.
    expect(first.next.commentsThrough).toBe("2026-10-14T09:59:30.000Z");

    // A comment made after that read, still before T3 Code's start time, counts next time.
    const second = evaluateJiraWatch(first.next, {
      issue: issue({ updated: "2026-10-14T09:59:50.000Z" }),
      comments: [
        comment("3", "2026-10-14T09:59:50.000Z", "account-ada"),
        comment("2", "2026-10-14T09:59:30.000Z", "account-bob"),
      ],
      ...own,
    });
    expect(second.changes).toEqual([
      { kind: "comments", comments: [comment("3", "2026-10-14T09:59:50.000Z", "account-ada")] },
    ]);
    expect(second.next.commentsThrough).toBe("2026-10-14T09:59:50.000Z");

    // A first read with no comments moves to the issue's own last update.
    const quiet = evaluateJiraWatch(started, {
      issue: issue({ updated: "2026-10-13T08:00:00.000Z" }),
      comments: [comment("1", "2026-10-13T07:00:00.000Z", "account-bob")],
      ...own,
    });
    expect(quiet.changes).toEqual([]);
    expect(quiet.next.commentsThrough).toBe("2026-10-13T08:00:00.000Z");
  });

  it("stops after the limit of comment-only wakes in a row", () => {
    const report = evaluateJiraWatch(watch({ wakes: JIRA_WATCH_WAKE_LIMIT - 1 }), {
      issue: issue(),
      comments: [comment("1", "2026-10-14T10:04:00.000Z", "account-bob")],
      ...own,
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
