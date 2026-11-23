import {
  IssueTrackerKind,
  JIRA_ISSUE_TRACKER_KIND,
  jiraProjectKeyOf,
  type OrchestrationV2ThreadShell,
  type ThreadIssueLink,
} from "@t3tools/contracts";

import { browseUrl } from "./issueMapping.ts";

const KIND = IssueTrackerKind.make(JIRA_ISSUE_TRACKER_KIND);

/**
 * A thread's Jira links as the tracker-neutral surfaces report them, tombstones left out. The
 * issue is read through the thread's project. A neutral link has no `branch` source, so a link
 * the server made from the branch name reads as `manual`. The title is the last synced summary.
 */
export function jiraLinksAsThreadIssues(
  thread: Pick<OrchestrationV2ThreadShell, "projectId" | "jiraIssues">,
): ReadonlyArray<ThreadIssueLink> {
  return (thread.jiraIssues ?? [])
    .filter((link) => link.source !== "branch-dismissed")
    .map((link) => ({
      tracker: KIND,
      host: link.site,
      scope: jiraProjectKeyOf(link.key),
      key: link.key,
      projectId: thread.projectId,
      url: browseUrl(link.site, link.key),
      source: link.source === "agent" ? "agent" : "manual",
      linkedAt: link.linkedAt,
      displayKey: link.key,
      title: link.snapshot?.summary.trim() || link.key,
    }));
}
