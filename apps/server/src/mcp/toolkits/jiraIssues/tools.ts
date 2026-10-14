import {
  IsoDateTime,
  JiraCommentProposal,
  JiraError,
  JiraIssueDraft,
  JiraIssueKeyString,
  JiraProposalResult,
  JiraProposalStatus,
  JiraStatusCategory,
  OrchestratorMcpFailure,
  ThreadId,
  ThreadJiraIssueLinkSource,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import {
  JiraProposalRecordError,
  JiraProposalRunInactiveError,
} from "../../../jira/JiraProposals.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  Orchestrator.OrchestratorV2,
];

const RECORD_ONLY =
  "This only records the link in T3 Code. To change the issue on the user's behalf, propose it with propose_jira_comment or propose_jira_transition; change it with jtk only when the user wants you to act as your own Jira identity.";

export const JiraIssueTargetInput = Schema.Struct({
  key: JiraIssueKeyString.annotate({ description: "Issue key, for example ABC-123." }),
  site: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Jira site host, for example acme.atlassian.net. Defaults to the site T3 Code reads Jira from.",
    }),
  ),
  threadId: Schema.optional(
    ThreadId.annotate({ description: "Thread to act on. Omit for this thread." }),
  ),
});
export type JiraIssueTargetInput = typeof JiraIssueTargetInput.Type;

export class JiraNotConfiguredError extends Schema.TaggedError<JiraNotConfiguredError>()(
  "JiraNotConfiguredError",
  {},
) {
  override get message(): string {
    return "Jira is not configured on this server. Pass site to link an issue anyway.";
  }
}

export class JiraSiteInvalidError extends Schema.TaggedError<JiraSiteInvalidError>()(
  "JiraSiteInvalidError",
  {},
) {
  override get message(): string {
    return "site must be a Jira site host such as acme.atlassian.net.";
  }
}

export class JiraThreadRequiredError extends Schema.TaggedError<JiraThreadRequiredError>()(
  "JiraThreadRequiredError",
  {},
) {
  override get message(): string {
    return "Pass threadId: this MCP client is not running inside a T3 thread.";
  }
}

export class JiraThreadNotFoundError extends Schema.TaggedError<JiraThreadNotFoundError>()(
  "JiraThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class JiraIssueLinkFailedError extends Schema.TaggedError<JiraIssueLinkFailedError>()(
  "JiraIssueLinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not link the Jira issue.";
  }
}

export class JiraIssueUnlinkFailedError extends Schema.TaggedError<JiraIssueUnlinkFailedError>()(
  "JiraIssueUnlinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not unlink the Jira issue.";
  }
}

export class JiraIssueListFailedError extends Schema.TaggedError<JiraIssueListFailedError>()(
  "JiraIssueListFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not list the thread's Jira issues.";
  }
}

export class JiraIssueWatchFailedError extends Schema.TaggedError<JiraIssueWatchFailedError>()(
  "JiraIssueWatchFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not change whether the Jira issue is watched.";
  }
}

export class JiraIssueWatchFromSubagentError extends Schema.TaggedError<JiraIssueWatchFromSubagentError>()(
  "JiraIssueWatchFromSubagentError",
  {},
) {
  override get message(): string {
    return "This thread is a subagent, so it cannot watch Jira issues. Its parent thread owns the issue: finish your task and report back instead.";
  }
}

export class JiraIssueWatchUnavailableError extends Schema.TaggedError<JiraIssueWatchUnavailableError>()(
  "JiraIssueWatchUnavailableError",
  { site: Schema.NullOr(Schema.String) },
) {
  override get message(): string {
    return this.site === null
      ? "Jira is not configured on this server, so T3 Code cannot watch Jira issues."
      : `T3 Code does not read Jira on ${this.site}, so it cannot watch issues there.`;
  }
}

export const JiraIssueToolError = Schema.Union([
  OrchestratorMcpFailure,
  JiraNotConfiguredError,
  JiraSiteInvalidError,
  JiraThreadRequiredError,
  JiraThreadNotFoundError,
  JiraIssueLinkFailedError,
  JiraIssueUnlinkFailedError,
  JiraIssueListFailedError,
  JiraIssueWatchFailedError,
  JiraIssueWatchFromSubagentError,
  JiraIssueWatchUnavailableError,
]);

const JiraIssueIdentity = {
  site: Schema.String,
  key: Schema.String,
  url: Schema.String.annotate({ description: "The issue's page on its site." }),
};

export const LinkJiraIssueResult = Schema.Struct({
  ...JiraIssueIdentity,
  alreadyLinked: Schema.Boolean.annotate({
    description: "True when the issue was linked to this thread before the call.",
  }),
  issue: Schema.NullOr(
    Schema.Struct({
      summary: Schema.String,
      status: Schema.String,
      statusCategory: JiraStatusCategory,
    }),
  ).annotate({ description: "The issue as T3 Code reads it; null when it could not be read." }),
  note: Schema.NullOr(Schema.String).annotate({
    description: "Why the issue could not be read. The link is recorded either way.",
  }),
});
export type LinkJiraIssueResult = typeof LinkJiraIssueResult.Type;

export const UnlinkJiraIssueResult = Schema.Struct({
  site: Schema.NullOr(Schema.String).annotate({
    description: "Null when no site was given, Jira is not configured and nothing was linked.",
  }),
  key: Schema.String,
  wasLinked: Schema.Boolean.annotate({
    description: "False when the issue was not linked to this thread to begin with.",
  }),
});
export type UnlinkJiraIssueResult = typeof UnlinkJiraIssueResult.Type;

export const WatchJiraIssueResult = Schema.Struct({
  site: Schema.NullOr(Schema.String).annotate({
    description: "Null when no site was given, Jira is not configured and nothing was watched.",
  }),
  key: Schema.String,
  watching: Schema.Boolean.annotate({ description: "Whether T3 Code watches it now." }),
  wasWatching: Schema.Boolean.annotate({
    description: "Whether T3 Code watched it for this thread before the call.",
  }),
});
export type WatchJiraIssueResult = typeof WatchJiraIssueResult.Type;

export const ThreadJiraIssueEntry = Schema.Struct({
  ...JiraIssueIdentity,
  source: ThreadJiraIssueLinkSource,
  linkedAt: IsoDateTime,
  summary: Schema.NullOr(Schema.String),
  statusCategory: Schema.NullOr(JiraStatusCategory),
  syncedAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When T3 Code last read the issue; null until it first has.",
  }),
});
export type ThreadJiraIssueEntry = typeof ThreadJiraIssueEntry.Type;

export const ListThreadJiraIssuesResult = Schema.Struct({
  issues: Schema.Array(ThreadJiraIssueEntry),
});
export type ListThreadJiraIssuesResult = typeof ListThreadJiraIssuesResult.Type;

const LinkJiraIssueTool = Tool.make("link_jira_issue", {
  description: `Link a Jira issue to this thread so T3 Code shows it beside the thread and keeps its summary and status current. Link the issue you are working on when the branch name does not already carry its key. ${RECORD_ONLY} Linking an already-linked issue succeeds with alreadyLinked=true.`,
  parameters: JiraIssueTargetInput,
  success: LinkJiraIssueResult,
  failure: JiraIssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Link Jira issue to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnlinkJiraIssueTool = Tool.make("unlink_jira_issue", {
  description: `Remove a Jira issue link from this thread, for example one linked by mistake. An unlinked issue stays unlinked even when the branch name carries its key. ${RECORD_ONLY} Unlinking an issue that is not linked succeeds with wasLinked=false.`,
  parameters: JiraIssueTargetInput,
  success: UnlinkJiraIssueResult,
  failure: JiraIssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Unlink Jira issue from thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreadJiraIssuesTool = Tool.make("list_thread_jira_issues", {
  description:
    "List the Jira issues linked to a thread (omit threadId for this thread) with the summary and status category T3 Code last read. Read the full issue with jtk.",
  parameters: Schema.Struct({
    threadId: Schema.optional(
      ThreadId.annotate({ description: "Thread to list. Omit for this thread." }),
    ),
  }),
  success: ListThreadJiraIssuesResult,
  failure: JiraIssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "List thread Jira issues")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const WatchJiraIssueTool = Tool.make("watch_jira_issue", {
  description:
    "Have T3 Code watch a Jira issue for this thread, linking it first if needed. T3 Code checks it every two minutes and wakes you with a message when someone else comments on it, its status moves to another category (To Do, In Progress, Done), or its assignee changes. Use this to follow an issue instead of polling, sleeping, or running a watcher. Only changes after this call wake you, so read the issue with jtk and handle what is already there first, then end your turn. While T3 Code watches, the thread stays in the user's Working list, not their inbox. When you hand the work back to the user, call unwatch_jira_issue first so the thread returns to their inbox. Watching ends when the thread settles or is archived, when the user stops this thread, when the issue is unlinked or T3 Code can no longer see it, after 10 wakes in a row that bring only comments, or when you call unwatch_jira_issue. Unsettle the thread before starting a new watch. A subagent cannot watch: its parent thread owns the issue.",
  parameters: JiraIssueTargetInput,
  success: WatchJiraIssueResult,
  failure: JiraIssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Watch Jira issue")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnwatchJiraIssueTool = Tool.make("unwatch_jira_issue", {
  description:
    "Stop T3 Code from watching a Jira issue for this thread. The issue stays linked. Unwatching an issue that is not watched succeeds with wasWatching=false.",
  parameters: JiraIssueTargetInput,
  success: WatchJiraIssueResult,
  failure: JiraIssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Stop watching Jira issue")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PROPOSAL_RULES =
  "The user reviews it in T3 Code, may edit it, and approves or rejects it; it is never applied automatically. Once approved, the user's own Jira account makes the change, not yours. Do not also make the same change with jtk. When the result is still pending the card stays open for the user, so do not propose it again; tell the user it is waiting for them.";

const ProposalSite = Schema.optional(
  TrimmedNonEmptyString.annotate({
    description:
      "Jira site host, for example acme.atlassian.net. Defaults to the site T3 Code reads Jira from.",
  }),
);

const ProposalWait = {
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 60 * 60 * 1_000 })),
  ).annotate({
    description:
      "How long to wait for the user's decision. Default 10 minutes. The card stays open after it.",
  }),
  clientRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))).annotate({
    description:
      "Reuse when retrying a call that lost its result, so the user sees one card and its outcome is returned again. Without one, proposing the same change again in this turn finds the same card.",
  }),
};

const IssueDraftInput = Schema.Struct({
  projectKey: JiraIssueDraft.fields.projectKey.annotate({ description: "Project key, e.g. ABC." }),
  issueType: JiraIssueDraft.fields.issueType.annotate({
    description: "Issue type name as the project names it, e.g. Story, Task, Bug or Sub-task.",
  }),
  summary: JiraIssueDraft.fields.summary,
  description: Schema.optional(JiraIssueDraft.fields.description).annotate({
    description: "Markdown.",
  }),
  parentKey: Schema.optional(JiraIssueDraft.fields.parentKey).annotate({
    description: "Epic or parent issue key; Jira requires one for a sub-task.",
  }),
  labels: Schema.optional(JiraIssueDraft.fields.labels),
  storyPoints: Schema.optional(JiraIssueDraft.fields.storyPoints),
  sprintId: Schema.optional(JiraIssueDraft.fields.sprintId).annotate({
    description: "Numeric sprint id.",
  }),
  assigneeAccountId: Schema.optional(JiraIssueDraft.fields.assigneeAccountId).annotate({
    description: "Jira account id of the assignee.",
  }),
});

const ProposeJiraIssuesInput = Schema.Struct({
  site: ProposalSite,
  issues: Schema.Array(IssueDraftInput).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  ...ProposalWait,
});

const ProposeJiraCommentInput = Schema.Struct({
  key: JiraIssueKeyString.annotate({ description: "Issue key, for example ABC-123." }),
  site: ProposalSite,
  body: JiraCommentProposal.fields.body.annotate({ description: "The comment, in Markdown." }),
  ...ProposalWait,
});

const ProposeJiraTransitionInput = Schema.Struct({
  key: JiraIssueKeyString.annotate({ description: "Issue key, for example ABC-123." }),
  site: ProposalSite,
  transition: TrimmedNonEmptyString.check(Schema.isMaxLength(255)).annotate({
    description:
      "The transition's name or id, or the name of the status it leads to, e.g. 'In Review'. An unknown one fails with the issue's available transitions.",
  }),
  comment: Schema.optional(Schema.NullOr(JiraCommentProposal.fields.body)).annotate({
    description: "Markdown comment posted after the transition.",
  }),
  ...ProposalWait,
});

export const JiraProposalToolResult = Schema.Struct({
  proposalId: Schema.String,
  status: JiraProposalStatus.annotate({
    description:
      "pending: waiting for the user, the card stays open. approved: the user approved it and it is being written. applied: done. rejected: the user declined. failed: error says why; the user may approve it again.",
  }),
  issues: Schema.optional(JiraProposalResult.fields.issues).annotate({
    description: "Issues written: the created ones, or the issue commented on or moved.",
  }),
  error: Schema.optional(Schema.String),
});
export type JiraProposalToolResult = typeof JiraProposalToolResult.Type;

const JiraProposalToolError = Schema.Union([
  OrchestratorMcpFailure,
  JiraError,
  JiraProposalRunInactiveError,
  JiraProposalRecordError,
]);

const proposalTool = <Name extends string, Parameters extends Schema.Top>(
  name: Name,
  title: string,
  description: string,
  parameters: Parameters,
) =>
  Tool.make(name, {
    description: `${description} ${PROPOSAL_RULES}`,
    parameters,
    success: JiraProposalToolResult,
    failure: JiraProposalToolError,
    dependencies,
  })
    .annotate(Tool.Title, title)
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, true);

const ProposeJiraIssuesTool = proposalTool(
  "propose_jira_issues",
  "Propose Jira issues",
  "Propose creating Jira issues for the user, shown as a card in this thread, and wait for their decision. Use it when the user wants issues created on their behalf.",
  ProposeJiraIssuesInput,
);

const ProposeJiraCommentTool = proposalTool(
  "propose_jira_comment",
  "Propose a Jira comment",
  "Propose posting a comment on a Jira issue for the user, shown as a card in this thread, and wait for their decision. Use it when the user wants a comment posted on their behalf.",
  ProposeJiraCommentInput,
);

const ProposeJiraTransitionTool = proposalTool(
  "propose_jira_transition",
  "Propose moving a Jira issue",
  "Propose moving a Jira issue through its workflow (a transition), optionally with a comment, for the user, shown as a card in this thread, and wait for their decision. Use it when the user wants an issue moved on their behalf.",
  ProposeJiraTransitionInput,
);

export const JiraIssuesToolkit = Toolkit.make(
  LinkJiraIssueTool,
  UnlinkJiraIssueTool,
  ListThreadJiraIssuesTool,
  WatchJiraIssueTool,
  UnwatchJiraIssueTool,
  ProposeJiraIssuesTool,
  ProposeJiraCommentTool,
  ProposeJiraTransitionTool,
);
