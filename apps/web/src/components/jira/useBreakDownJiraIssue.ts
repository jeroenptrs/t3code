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
  const [pendingIssueId, setPendingIssueId] = useState<string | null>(null);

  const breakDown = async (issue: JiraIssueKey, projectRef: ScopedProjectRef) => {
    setPendingIssueId(jiraIssueKeyOf(issue));
    const result = await startBreakdown({
      environmentId: projectRef.environmentId,
      input: { site: issue.site, key: issue.key, projectId: projectRef.projectId },
    });
    setPendingIssueId(null);
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

  return { breakDown, pendingIssueId };
}
