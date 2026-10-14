import type {
  JiraComment,
  JiraIssueSummary,
  JiraStatusCategory,
  JiraUser,
  OrchestrationV2Notification,
  ThreadJiraIssueWatch,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Wakes in a row that bring only comments. A status or assignee change resets the count, so
 * this only stops a chatty commenter looping an agent that is replying to it.
 */
export const JIRA_WATCH_WAKE_LIMIT = 10;
const LISTED_COMMENTS = 5;
const EXCERPT_LENGTH = 200;

type JiraWatchChange =
  | {
      readonly kind: "status";
      readonly from: JiraStatusCategory;
      readonly to: JiraStatusCategory;
      readonly status: string;
    }
  | { readonly kind: "assignee"; readonly wasAssigned: boolean; readonly to: JiraUser | null }
  /** Oldest first. */
  | { readonly kind: "comments"; readonly comments: ReadonlyArray<JiraComment> };

interface JiraWatchReport {
  /** What the agent has not been told yet. Empty means no wake. */
  readonly changes: ReadonlyArray<JiraWatchChange>;
  /** The watch to record, whether or not anything is reported. */
  readonly next: ThreadJiraIssueWatch;
  /** This report spends the last wake before the limit, so watching stops after it. */
  readonly exhausted: boolean;
}

/**
 * How far before a watch's start the first read still counts comments. `startedAt` is T3 Code's
 * clock and a comment's `created` is Jira's, which can disagree by a little.
 */
const START_GRACE_MS = 2 * 60 * 1000;

/** The latest of Jira's timestamps, or null when there is none. */
function latestJiraTime(times: ReadonlyArray<string | null>): string | null {
  let latest: { readonly time: string; readonly ms: number } | null = null;
  for (const time of times) {
    if (time === null) continue;
    const ms = Date.parse(time);
    if (Number.isNaN(ms) || (latest !== null && ms <= latest.ms)) continue;
    latest = { time, ms };
  }
  return latest?.time ?? null;
}

/**
 * Compares a watched issue with what the last read saw. Comments count when created after
 * `commentsThrough`, or on the first read after a watch starts, after a short grace before
 * `startedAt`. Comments T3 Code posted, and comments by any account a configured identity
 * comments as, never count. `commentsThrough` then moves only by Jira's own timestamps, so the
 * two clocks are never compared again. The first read only learns the status category and the
 * assignee, so starting a watch wakes the agent only for a comment that just came in.
 */
export function evaluateJiraWatch(
  watch: ThreadJiraIssueWatch,
  read: {
    readonly issue: Pick<JiraIssueSummary, "status" | "statusCategory" | "assignee" | "updated">;
    /** The issue's newest comments, in any order. */
    readonly comments: ReadonlyArray<JiraComment>;
    /** Accounts T3 Code's configured identities comment as. */
    readonly ownAccountIds: ReadonlySet<string>;
    /** Ids of the read comments that T3 Code posted, for a user or an approved proposal. */
    readonly ownCommentIds: ReadonlySet<string>;
  },
): JiraWatchReport {
  const changes: Array<JiraWatchChange> = [];
  const firstRead = watch.updatedThrough === null;
  const { issue } = read;

  if (
    !firstRead &&
    watch.statusCategory !== null &&
    watch.statusCategory !== issue.statusCategory
  ) {
    changes.push({
      kind: "status",
      from: watch.statusCategory,
      to: issue.statusCategory,
      status: issue.status,
    });
  }

  const assigneeAccountId = issue.assignee?.accountId ?? null;
  if (!firstRead && assigneeAccountId !== watch.assigneeAccountId) {
    changes.push({
      kind: "assignee",
      wasAssigned: watch.assigneeAccountId !== null,
      to: issue.assignee,
    });
  }

  const through = firstRead
    ? Date.parse(watch.startedAt) - START_GRACE_MS
    : Date.parse(watch.commentsThrough);
  const fresh = read.comments
    .filter(
      (comment) =>
        Date.parse(comment.created) > through &&
        !read.ownCommentIds.has(comment.id) &&
        (comment.author === null || !read.ownAccountIds.has(comment.author.accountId)),
    )
    .toSorted((left, right) => Date.parse(left.created) - Date.parse(right.created));
  if (fresh.length > 0) changes.push({ kind: "comments", comments: fresh });

  const commentsOnly = changes.length > 0 && changes.every((change) => change.kind === "comments");
  const progress = changes.some((change) => change.kind !== "comments");
  const wakes = (progress ? 0 : watch.wakes) + (commentsOnly ? 1 : 0);
  // Every comment read, counted or not, is behind this mark, and so is the issue's last edit.
  const commentsThrough =
    latestJiraTime([
      ...read.comments.map((comment) => comment.created),
      issue.updated,
      firstRead ? null : watch.commentsThrough,
    ]) ?? (firstRead ? DateTime.formatIso(DateTime.makeUnsafe(through)) : watch.commentsThrough);
  return {
    changes,
    next: {
      startedAt: watch.startedAt,
      updatedThrough: issue.updated,
      statusCategory: issue.statusCategory,
      assigneeAccountId,
      commentsThrough,
      wakes,
    },
    exhausted: commentsOnly && wakes >= JIRA_WATCH_WAKE_LIMIT,
  };
}

const CATEGORY_LABEL: Record<JiraStatusCategory, string> = {
  todo: "To Do",
  "in-progress": "In Progress",
  done: "Done",
};

function excerpt(body: string): string {
  const text = body.replaceAll(/\s+/g, " ").trim();
  return text.length <= EXCERPT_LENGTH ? text : `${text.slice(0, EXCERPT_LENGTH - 3)}...`;
}

function changeLines(change: JiraWatchChange): Array<string> {
  switch (change.kind) {
    case "status":
      return [
        `- Status moved from ${CATEGORY_LABEL[change.from]} to ${CATEGORY_LABEL[change.to]} (now "${change.status}").`,
      ];
    case "assignee":
      return [
        change.to === null
          ? "- The issue is now unassigned."
          : `- ${change.wasAssigned ? "Reassigned" : "Assigned"} to ${change.to.displayName || "someone"}${change.wasAssigned ? "" : " (was unassigned)"}.`,
      ];
    case "comments": {
      const { comments } = change;
      const lines = comments.slice(-LISTED_COMMENTS).map((comment) => {
        const body = excerpt(comment.body);
        return `  - ${comment.author?.displayName || "Someone"}: ${body.length === 0 ? "(no text)" : `"${body}"`}`;
      });
      if (comments.length > LISTED_COMMENTS) {
        lines.unshift(`  - and ${comments.length - LISTED_COMMENTS} earlier ones`);
      }
      return [
        `- ${comments.length} new ${comments.length === 1 ? "comment" : "comments"}:`,
        ...lines,
      ];
    }
  }
}

const SUMMARY: Record<JiraWatchChange["kind"], string> = {
  status: "status changed",
  assignee: "assignee changed",
  comments: "new comments",
};

/** The wake the agent reads and the timeline notification the user sees. */
export function jiraWatchMessage(input: {
  readonly key: string;
  readonly summary: string;
  readonly url: string;
  readonly report: JiraWatchReport;
}): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const { changes, exhausted } = input.report;
  const text = [
    `Update on Jira issue ${input.key} "${input.summary}" (${input.url}), which T3 Code is watching for you:`,
    ...changes.flatMap(changeLines),
    "",
    exhausted
      ? `T3 Code stopped watching after ${JIRA_WATCH_WAKE_LIMIT} comment-only updates in a row. Read the issue with jtk, and call watch_jira_issue to watch it again.`
      : "Read the issue with jtk for the full details, then act on each item as your task requires. T3 Code keeps watching and wakes you on the next new comment, status change or assignee change, so end your turn when you are done. When you hand the work back to the user, call unwatch_jira_issue first so the thread returns to their inbox.",
  ].join("\n");
  const summary = changes.map((change) => SUMMARY[change.kind]);
  if (exhausted) summary.push("stopped watching");
  return {
    text,
    notification: {
      source: { kind: "monitor" },
      outcome: changes.some((change) => change.kind === "status" && change.to === "done")
        ? "completed"
        : "updated",
      summary: `${input.key}: ${summary.join(", ")}`,
    },
  };
}

/** The wake that ends a watch on an issue the reader can no longer see. */
export function jiraWatchLostMessage(input: { readonly key: string; readonly url: string }): {
  readonly text: string;
  readonly notification: OrchestrationV2Notification;
} {
  return {
    text: `T3 Code stopped watching Jira issue ${input.key} (${input.url}) because its Jira reader can no longer see it: it was deleted, moved or its permissions changed. Check it with jtk, and call watch_jira_issue to watch it again.`,
    notification: {
      source: { kind: "monitor" },
      outcome: "failed",
      summary: `${input.key}: stopped watching, cannot see it`,
    },
  };
}
