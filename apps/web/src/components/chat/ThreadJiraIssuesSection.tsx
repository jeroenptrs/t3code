import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  jiraIssueKeyOf,
  jiraIssueUrl,
  visibleThreadJiraIssues,
} from "@t3tools/client-runtime/state/jira";
import type { EnvironmentId, ThreadId, ThreadJiraIssueLink } from "@t3tools/contracts";
import { ExternalLinkIcon, PlusIcon, UnlinkIcon } from "lucide-react";
import { useState } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { useJiraIssueLinking } from "~/hooks/useJiraIssueLinking";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";

import { openJiraIssueDialog } from "../jira/LinkJiraIssueDialog";
import { JIRA_STATUS_CATEGORY_LABEL, JiraStatusDot } from "../jira/jiraPresentation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_LABEL_CLASS } from "./threadDetailsPanelStyles";

/**
 * The thread's linked Jira issues, from the shell snapshot alone: key, summary and status
 * category. Opening one reads the rest. Hidden when Jira is off here and nothing is linked; with
 * links but no Jira, the rows stay so they can still be opened in Jira or unlinked.
 */
export function ThreadJiraIssuesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const shell = useThreadShell(threadRef);
  const linking = useJiraIssueLinking(props.environmentId);
  const openLink = useOpenLink(threadRef);
  const [unlinkingKey, setUnlinkingKey] = useState<string | null>(null);
  const links = visibleThreadJiraIssues(shell?.source.jiraIssues);
  if (links.length === 0 && !linking.canLink) return null;

  const unlink = async (link: ThreadJiraIssueLink) => {
    setUnlinkingKey(jiraIssueKeyOf(link));
    try {
      await linking.changeLink(threadRef, link, false);
    } catch {
      // The command reports its own failure.
    } finally {
      setUnlinkingKey(null);
    }
  };
  const openInJira = (link: ThreadJiraIssueLink) =>
    void openLink(jiraIssueUrl(link)).catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Unable to open Jira",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });

  return (
    <ThreadDetailsSection
      headingId="thread-details-jira-heading"
      title="Jira"
      actions={
        linking.canLink ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  aria-label="Link Jira issue"
                  onClick={() => openJiraIssueDialog(threadRef, "link")}
                >
                  <PlusIcon className="size-3.5" />
                </ThreadDetailsControl>
              }
            />
            <TooltipPopup>Link Jira issue</TooltipPopup>
          </Tooltip>
        ) : null
      }
    >
      {linking.capabilities !== null && !linking.configured && links.length > 0 ? (
        <p className="px-2.5 pb-1 text-2xs text-muted-foreground">
          Jira is not configured on this server.
        </p>
      ) : null}
      {links.length === 0 ? (
        <ThreadDetailsControl
          variant="ghost"
          size="sm"
          part="row"
          tone="muted"
          onClick={() => openJiraIssueDialog(threadRef, "link")}
        >
          <PlusIcon aria-hidden className="size-4 shrink-0" />
          Link Jira issue
        </ThreadDetailsControl>
      ) : (
        <ul className="m-0 list-none p-0">
          {links.map((link) => {
            const id = jiraIssueKeyOf(link);
            const category = link.snapshot?.statusCategory ?? null;
            return (
              <li key={id} className="flex min-w-0 items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <ThreadDetailsControl
                        variant="ghost"
                        size="sm"
                        part="row"
                        className="flex-1"
                        aria-label={`Open ${link.key}`}
                        onClick={() => useRightPanelStore.getState().openJiraIssue(threadRef, link)}
                      />
                    }
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      <JiraStatusDot category={category} />
                    </span>
                    <span
                      className={`min-w-0 flex-1 truncate text-left ${THREAD_DETAILS_PANEL_LABEL_CLASS}`}
                    >
                      {link.key}
                      {link.snapshot ? (
                        <span className="text-muted-foreground"> {link.snapshot.summary}</span>
                      ) : null}
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    {category === null
                      ? `${link.key} · not synced yet`
                      : `${link.key} · ${JIRA_STATUS_CATEGORY_LABEL[category]}`}
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <ThreadDetailsControl
                        size="icon-xs"
                        variant="ghost"
                        part="icon"
                        tone="muted"
                        aria-label={`Open ${link.key} in Jira`}
                        onClick={() => openInJira(link)}
                      >
                        <ExternalLinkIcon className="size-3.5" />
                      </ThreadDetailsControl>
                    }
                  />
                  <TooltipPopup>Open in Jira</TooltipPopup>
                </Tooltip>
                {linking.canUnlink ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <ThreadDetailsControl
                          size="icon-xs"
                          variant="ghost"
                          part="icon"
                          tone="muted"
                          aria-label={`Unlink ${link.key}`}
                          disabled={unlinkingKey !== null}
                          onClick={() => void unlink(link)}
                        >
                          <UnlinkIcon className="size-3.5" />
                        </ThreadDetailsControl>
                      }
                    />
                    <TooltipPopup>Unlink from thread</TooltipPopup>
                  </Tooltip>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </ThreadDetailsSection>
  );
}
