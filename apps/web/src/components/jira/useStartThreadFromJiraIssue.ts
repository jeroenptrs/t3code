import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type JiraIssueSummary,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useState } from "react";

import { useComposerDraftStore, type DraftId } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readProjects } from "~/state/entities";
import { jiraEnvironment, jiraFailureReason } from "~/state/jira";
import { environmentServerConfigsAtom } from "~/state/server";

import { toastManager } from "../ui/toast";
import { jiraIssueThreadPrompt, proposeJiraIssueBranchName } from "./jiraIssueList.logic";

/** Text the user already typed in that draft is only replaced when they say so. */
function placeIssuePrompt(draftId: DraftId, key: string, prompt: string): void {
  const store = useComposerDraftStore.getState();
  const existing = store.getComposerDraft(draftId)?.prompt ?? "";
  if (existing.trim().length === 0 || existing === prompt) {
    store.setPrompt(draftId, prompt);
    return;
  }
  const id = toastManager.add({
    type: "info",
    title: `${key} is ready to start`,
    description: "This project already has a draft. Replace it with the issue?",
    timeout: 0,
    actionProps: {
      children: "Replace draft",
      onClick: () => {
        toastManager.close(id);
        useComposerDraftStore.getState().setPrompt(draftId, prompt);
      },
    },
  });
}

/**
 * Opens a new thread draft in a project with the issue written into its composer, for the user
 * to read, edit and send. The description is read at click time, since rows do not carry it.
 * Nothing links the issue here: the proposed branch carries the key, and the server's branch
 * detector links it once the thread's branch is named.
 */
export function useStartThreadFromJiraIssue(environmentId: EnvironmentId | null) {
  const newThread = useNewThreadHandler();
  const [startingKey, setStartingKey] = useState<string | null>(null);

  const start = async (issue: JiraIssueSummary, projectRef: ScopedProjectRef) => {
    if (environmentId === null) return;
    setStartingKey(issue.key);
    try {
      const detail = await executeAtomQuery(
        appAtomRegistry,
        jiraEnvironment.issue({
          environmentId,
          input: { site: issue.site, key: issue.key },
        }),
        { reportFailure: false },
      );
      if (detail._tag === "Failure") {
        const reason = jiraFailureReason(squashAtomCommandFailure(detail));
        toastManager.add({
          type: "error",
          title: `Could not read ${issue.key}`,
          description:
            reason === "unauthorized" || reason === "forbidden"
              ? "Jira refused the server's reader identity."
              : reason === "not-found"
                ? "The issue no longer exists, or the reader identity cannot see it."
                : "Try again in a moment.",
        });
        return;
      }
      const settings =
        appAtomRegistry.get(environmentServerConfigsAtom).get(projectRef.environmentId)?.settings ??
        DEFAULT_SERVER_SETTINGS;
      const project = readProjects().find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      );
      const naming = resolveProjectSettings(
        settings,
        projectRef.projectId,
        project ?? null,
      ).settings;
      const branch = proposeJiraIssueBranchName(issue, {
        mode: naming.branchNamingMode,
        prefix: naming.branchNamePrefix,
        instructions: naming.branchNameInstructions,
      });
      const session = await newThread(projectRef).catch(() => null);
      if (session === null) {
        toastManager.add({
          type: "error",
          title: "Could not open a thread",
          description: "Try again from the project.",
        });
        return;
      }
      placeIssuePrompt(session.draftId, issue.key, jiraIssueThreadPrompt(detail.value, branch));
    } finally {
      setStartingKey(null);
    }
  };

  return { start, startingKey };
}
