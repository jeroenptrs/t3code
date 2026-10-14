import type {
  JiraComment,
  JiraIssueSummary,
  JiraStatusCategory,
  JiraUser,
  OrchestrationV2Notification,
  ThreadJiraIssueWatch,
} from "@t3tools/contracts";

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
 * Compares a watched issue with what the last read saw. Comments count when created after
 * `commentsThrough` by anyone but the account T3 Code reads Jira as. The first read after a
 * watch starts only learns the assignee, and the status category when the link had no snapshot
 * to start from, so starting a watch never wakes the agent by itself.
 */
export function evaluateJiraWatch(
  watch: ThreadJiraIssueWatch,
  read: {
    readonly issue: Pick<JiraIssueSummary, "status" | "statusCategory" | "assignee" | "updated">;
    /** The issue's newest comments, in any order. */
    readonly comments: ReadonlyArray<JiraComment>;
    readonly readerAccountId: string | null;
  },
): JiraWatchReport {
  const changes: Array<JiraWatchChange> = [];
  const firstRead = watch.updatedThrough === null;
  const { issue } = read;

  if (watch.statusCategory !== null && watch.statusCategory !== issue.statusCategory) {
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

  const through = Date.parse(watch.commentsThrough);
  const unseen = read.comments
    .filter((comment) => Date.parse(comment.created) > through)
    .toSorted((left, right) => Date.parse(left.created) - Date.parse(right.created));
  const fresh = unseen.filter(
    (comment) =>
      read.readerAccountId === null || comment.author?.accountId !== read.readerAccountId,
  );
  if (fresh.length > 0) changes.push({ kind: "comments", comments: fresh });

  const commentsOnly = changes.length > 0 && changes.every((change) => change.kind === "comments");
  const progress = changes.some((change) => change.kind !== "comments");
  const wakes = (progress ? 0 : watch.wakes) + (commentsOnly ? 1 : 0);
  return {
    changes,
    next: {
      startedAt: watch.startedAt,
      updatedThrough: issue.updated,
      statusCategory: issue.statusCategory,
      assigneeAccountId,
      // The reader's own comments move it too, so they are not looked at again.
      commentsThrough: unseen.at(-1)?.created ?? watch.commentsThrough,
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
