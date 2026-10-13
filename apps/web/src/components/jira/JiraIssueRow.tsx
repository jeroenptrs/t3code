import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { JiraIssueSummary } from "@t3tools/contracts";
import { MessageSquarePlusIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";

import { ProjectFavicon } from "../ProjectFavicon";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowLines,
} from "../pullRequest/PullRequestListRow";
import { PullRequestActorAvatar } from "../pullRequest/pullRequestPresentation";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { JiraStatusBadge } from "./jiraPresentation";

function JiraIssueRowImpl({
  issue,
  selected,
  projects,
  starting,
  onSelect,
  onStartThread,
}: {
  issue: JiraIssueSummary;
  selected: boolean;
  /** Where a thread for this issue can start: the projects on the Jira environment. */
  projects: ReadonlyArray<EnvironmentProject>;
  starting: boolean;
  onSelect: (issue: JiraIssueSummary) => void;
  onStartThread: (issue: JiraIssueSummary, project: EnvironmentProject) => void;
}) {
  const sprintNames = issue.sprints.map((sprint) => sprint.name).join(", ");
  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-md pr-2 [content-visibility:auto] [contain-intrinsic-block-size:56.5px]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(issue)}
        className={cn(
          PULL_REQUEST_ROW_CLASS,
          "min-w-0 flex-1 cursor-pointer px-3 py-2.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        )}
      >
        <PullRequestRowLines
          number={<span className={PULL_REQUEST_ROW_NUMBER_CLASS}>{issue.key}</span>}
          title={issue.summary}
          status={
            issue.storyPoints === null ? null : (
              <span className="tabular-nums text-muted-foreground">
                {issue.storyPoints} pt<span className="sr-only"> story points</span>
              </span>
            )
          }
          meta={
            <>
              <JiraStatusBadge category={issue.statusCategory} status={issue.status} size="sm" />
              {issue.issueType ? <span className="shrink-0">{issue.issueType}</span> : null}
              {issue.priority ? <span className="shrink-0">{issue.priority}</span> : null}
              <span className="inline-flex min-w-0 max-w-40 items-center gap-1">
                <PullRequestActorAvatar
                  actor={
                    issue.assignee === null
                      ? null
                      : {
                          login: issue.assignee.displayName || "?",
                          name: issue.assignee.displayName,
                          avatarUrl: issue.assignee.avatarUrl,
                        }
                  }
                  className="size-3.5"
                />
                <span className="truncate">{issue.assignee?.displayName ?? "Unassigned"}</span>
              </span>
              {sprintNames ? <span className="min-w-0 truncate">{sprintNames}</span> : null}
            </>
          }
          updatedAt={issue.updated}
        />
      </button>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Start thread from ${issue.key}`}
              title="Start thread from issue"
              disabled={starting}
            />
          }
        >
          {starting ? <Spinner aria-hidden size="sm" /> : <MessageSquarePlusIcon aria-hidden />}
        </MenuTrigger>
        <MenuPopup align="end" side="bottom">
          <MenuGroup>
            <MenuGroupLabel>Start thread in</MenuGroupLabel>
            {projects.length === 0 ? (
              <MenuItem disabled>No projects on this server</MenuItem>
            ) : (
              projects.map((project) => (
                <MenuItem
                  key={`${project.environmentId}:${project.id}`}
                  onClick={() => onStartThread(issue, project)}
                >
                  <ProjectFavicon project={project} className="size-3.5" />
                  <span className="min-w-0 truncate">{project.title}</span>
                </MenuItem>
              ))
            )}
          </MenuGroup>
        </MenuPopup>
      </Menu>
    </div>
  );
}

/** Memoized: facet and paging changes re-render the list, rarely a given row. */
export const JiraIssueRow = memo(JiraIssueRowImpl);
