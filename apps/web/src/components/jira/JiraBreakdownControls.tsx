import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, JiraIssueKey, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, ListTreeIcon } from "lucide-react";

import { JIRA_ISSUES_PANEL_REF } from "~/rightPanelStore";
import { useProjects, useThreadShell } from "~/state/entities";

import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { JIRA_BREAKDOWN_NEEDS_TOKEN, jiraBreakdownProjects } from "./jiraBreakdown.logic";
import type { JiraIssueWriteAccess } from "./jiraIssueWrite.logic";
import { useBreakDownJiraIssue } from "./useBreakDownJiraIssue";

/** The projects an issue's thread can start in, as menu items. */
export function JiraProjectMenuItems(props: {
  projects: ReadonlyArray<EnvironmentProject>;
  onPick: (project: EnvironmentProject) => void;
}) {
  if (props.projects.length === 0) {
    return <MenuItem disabled>No projects on this server</MenuItem>;
  }
  return props.projects.map((project) => (
    <MenuItem key={`${project.environmentId}:${project.id}`} onClick={() => props.onPick(project)}>
      <ProjectFavicon project={project} className="size-3.5" />
      <span className="min-w-0 truncate">{project.title}</span>
    </MenuItem>
  ));
}

/**
 * "Break down" for an issue shown in a right panel: beside a thread it starts in that thread's
 * project; on the Jira pages the user picks one, as starting a thread from the issue does.
 * `access` is the panel's, from `jiraIssueWriteAccess` with the start-breakdown grant.
 */
export function JiraIssueBreakdownAction(props: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  issue: JiraIssueKey;
  access: JiraIssueWriteAccess;
}) {
  const { environmentId, threadRef, issue, access } = props;
  const besideThread = scopedThreadKey(threadRef) !== scopedThreadKey(JIRA_ISSUES_PANEL_REF);
  const shell = useThreadShell(besideThread ? threadRef : null);
  const allProjects = useProjects();
  const { breakDown, isPending } = useBreakDownJiraIssue();
  // Beside a thread whose shell has not arrived, there is no project to offer yet.
  if (access === "hidden" || (besideThread && shell === null)) return null;

  const pending = isPending(issue);
  const label = (
    <>
      {pending ? <Spinner aria-hidden size="sm" /> : <ListTreeIcon aria-hidden />}
      {pending ? "Starting…" : "Break down"}
    </>
  );
  if (access === "needs-token") {
    return (
      <Button size="xs" variant="outline" disabled title={JIRA_BREAKDOWN_NEEDS_TOKEN}>
        {label}
      </Button>
    );
  }
  const choice = jiraBreakdownProjects({
    environmentId,
    threadProjectId: shell?.projectId ?? null,
    projects: allProjects,
  });
  if (choice.kind === "thread") {
    return (
      <Button
        size="xs"
        variant="outline"
        disabled={pending}
        aria-busy={pending}
        title="Start a thread that proposes this issue's work packages"
        onClick={() => void breakDown(issue, scopeProjectRef(environmentId, choice.projectId))}
      >
        {label}
      </Button>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="xs" variant="outline" disabled={pending} aria-busy={pending}>
            {label}
            <ChevronDownIcon aria-hidden className="size-3.5" />
          </Button>
        }
      />
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Break down in</MenuGroupLabel>
          <JiraProjectMenuItems
            projects={choice.projects}
            onPick={(project) =>
              void breakDown(issue, scopeProjectRef(project.environmentId, project.id))
            }
          />
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
