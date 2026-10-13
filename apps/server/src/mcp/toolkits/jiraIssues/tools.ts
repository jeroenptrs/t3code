import {
  IsoDateTime,
  JiraIssueKeyString,
  JiraStatusCategory,
  OrchestratorMcpFailure,
  ThreadId,
  ThreadJiraIssueLinkSource,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  Orchestrator.OrchestratorV2,
];

const RECORD_ONLY =
  "This only records the link in T3 Code. Change the issue itself (comment, transition, edit) with jtk, which acts as your own Jira identity.";

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

export const JiraIssueToolError = Schema.Union([
  OrchestratorMcpFailure,
  JiraNotConfiguredError,
  JiraSiteInvalidError,
  JiraThreadRequiredError,
  JiraThreadNotFoundError,
  JiraIssueLinkFailedError,
  JiraIssueUnlinkFailedError,
  JiraIssueListFailedError,
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
  description: `Remove a Jira issue link from this thread, for example one linked by mistake. A link T3 Code made from the branch name stays removed. ${RECORD_ONLY} Unlinking an issue that is not linked succeeds with wasLinked=false.`,
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

export const JiraIssuesToolkit = Toolkit.make(
  LinkJiraIssueTool,
  UnlinkJiraIssueTool,
  ListThreadJiraIssuesTool,
);
