import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { jiraIssueKeyOf } from "@t3tools/client-runtime/state/jira";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { JiraIssueKey, ScopedProjectRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { jiraEnvironment } from "~/state/jira";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";

import { toastManager } from "../ui/toast";
import { jiraBreakdownFailureToast } from "./jiraBreakdown.logic";

/**
 * Starts a breakdown of an issue in a project and opens its thread, including one already running
 * for the issue. The server returns once the thread exists; the agent works in the background.
 */
export function useBreakDownJiraIssue() {
  const navigate = useNavigate();
  const startBreakdown = useAtomCommand(jiraEnvironment.startBreakdown, {
    label: "start Jira breakdown",
    // Failures are shown as a toast below.
    reportFailure: false,
  });
  // Per issue and project, so one start ending does not clear another's.
  const [pendingStarts, setPendingStarts] = useState<ReadonlySet<string>>(() => new Set());

  const breakDown = async (issue: JiraIssueKey, projectRef: ScopedProjectRef) => {
    const startKey = pendingStartKey(issue, projectRef);
    setPendingStarts((current) => new Set(current).add(startKey));
    const result = await startBreakdown({
      environmentId: projectRef.environmentId,
      input: { site: issue.site, key: issue.key, projectId: projectRef.projectId },
    });
    setPendingStarts((current) => {
      const next = new Set(current);
      next.delete(startKey);
      return next;
    });
    if (result._tag === "Success") {
      if (!result.value.started) {
        toastManager.add({
          type: "info",
          title: `${issue.key} is already being broken down`,
          description: "Opening the thread it runs in.",
        });
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(projectRef.environmentId, result.value.threadId),
        ),
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    toastManager.add({
      type: "error",
      ...jiraBreakdownFailureToast(squashAtomCommandFailure(result), issue),
    });
  };

  /** Whether a start of the issue is in flight, in any project. */
  const isPending = (issue: JiraIssueKey) => {
    const issuePrefix = `${jiraIssueKeyOf(issue)}\u0000`;
    for (const startKey of pendingStarts) {
      if (startKey.startsWith(issuePrefix)) return true;
    }
    return false;
  };

  return { breakDown, isPending };
}

const pendingStartKey = (issue: JiraIssueKey, projectRef: ScopedProjectRef) =>
  `${jiraIssueKeyOf(issue)}\u0000${projectRef.environmentId}\u0000${projectRef.projectId}`;
