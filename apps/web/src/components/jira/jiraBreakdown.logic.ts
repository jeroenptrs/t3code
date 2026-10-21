/**
 * Fork-only. Where "Break down" runs and which issue it acts on. A breakdown is a thread the server
 * starts in a T3 project; its agent proposes the issue's work packages, which the user approves
 * with their own Jira token.
 */
import { jiraIssueKeyOf } from "@t3tools/client-runtime/state/jira";
import {
  JiraError,
  type EnvironmentId,
  type JiraIssueKey,
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { jiraProposalFailureMessage } from "./jiraProposal.logic";

/** Why "Break down" is disabled for a session that could add a token. */
export const JIRA_BREAKDOWN_NEEDS_TOKEN =
  "Needs your Jira token in Settings → Account, since you approve what it proposes with your own account.";

/**
 * The projects a thread for an issue can start in, by title: those on the Jira environment, since
 * the thread runs where Jira is configured, so it can read the issue and link it.
 */
export function jiraIssueThreadProjects<
  P extends { readonly environmentId: EnvironmentId; readonly title: string },
>(projects: ReadonlyArray<P>, environmentId: EnvironmentId): ReadonlyArray<P> {
  return projects
    .filter((project) => project.environmentId === environmentId)
    .toSorted((left, right) => left.title.localeCompare(right.title));
}

/**
 * Where a breakdown starts: in the thread's own project when the issue is shown beside a thread,
 * otherwise in a project the user picks, as starting a thread from the issue does.
 */
export function jiraBreakdownProjects<
  P extends { readonly environmentId: EnvironmentId; readonly title: string },
>(input: {
  readonly environmentId: EnvironmentId;
  readonly threadProjectId: ProjectId | null;
  readonly projects: ReadonlyArray<P>;
}):
  | { readonly kind: "thread"; readonly projectId: ProjectId }
  | { readonly kind: "choose"; readonly projects: ReadonlyArray<P> } {
  return input.threadProjectId !== null
    ? { kind: "thread", projectId: input.threadProjectId }
    : { kind: "choose", projects: jiraIssueThreadProjects(input.projects, input.environmentId) };
}

/**
 * The issue the palette's "Break down Jira issue…" acts on: the one open in the Jira panel, else a
 * thread's only linked issue. With several linked and none open, the user opens one first.
 */
export function jiraBreakdownPaletteIssue(input: {
  readonly openIssue: JiraIssueKey | null;
  readonly linkedIssues: ReadonlyArray<JiraIssueKey>;
}): JiraIssueKey | null {
  if (input.openIssue !== null) return input.openIssue;
  const keys = new Set(input.linkedIssues.map(jiraIssueKeyOf));
  return keys.size === 1 ? input.linkedIssues[0]! : null;
}

const isJiraError = Schema.is(JiraError);

/** The toast for a breakdown the server refused, in its own words where it has them. */
export function jiraBreakdownFailureToast(
  failure: unknown,
  issue: JiraIssueKey,
): { readonly title: string; readonly description: string } {
  return {
    title: `Could not break down ${issue.key}`,
    description:
      isJiraError(failure) && failure.reason === "personal-token-required"
        ? `Add your Jira token for ${issue.site} in Settings → Account first.`
        : jiraProposalFailureMessage(failure),
  };
}
