import { IssueOperationError, JIRA_ISSUE_TRACKER_KIND } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const PROPOSAL_TOOL = {
  create: "propose_jira_issues",
  comment: "propose_jira_comment",
  setState: "propose_jira_transition",
} as const;

/**
 * Fails a tracker-neutral MCP write that targets Jira, and names the proposal tool to call
 * instead. An agent never writes to Jira itself: a user approves each proposal.
 */
export const refuseAgentJiraWrite = (tracker: string, operation: keyof typeof PROPOSAL_TOOL) =>
  tracker === JIRA_ISSUE_TRACKER_KIND
    ? Effect.fail(
        new IssueOperationError({
          operation,
          detail: `Agents never write to Jira directly, so nothing was written. Call ${PROPOSAL_TOOL[operation]} instead: a user approves the proposal before it reaches Jira.`,
        }),
      )
    : Effect.void;
