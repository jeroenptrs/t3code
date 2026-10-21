import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { jiraIssueKeyOf } from "@t3tools/client-runtime/state/jira";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, JiraIssueKey, ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ListTreeIcon } from "lucide-react";

import { JIRA_ISSUES_PANEL_REF } from "~/rightPanelStore";
import { useProjects, useThreadShell } from "~/state/entities";
import { jiraEnvironment, useJiraCapabilities } from "~/state/jira";

import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { JIRA_BREAKDOWN_NEEDS_TOKEN, jiraBreakdownProjects } from "./jiraBreakdown.logic";
import { jiraIssueWriteAccess } from "./jiraIssueWrite.logic";
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
 */
export function JiraIssueBreakdownAction(props: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  issue: JiraIssueKey;
}) {
  const { environmentId, threadRef, issue } = props;
  const capabilities = useJiraCapabilities(environmentId);
  const canOperate = useAtomValue(jiraEnvironment.startBreakdown.permissionAtom(environmentId));
  const access = jiraIssueWriteAccess({ capabilities, canOperate, site: issue.site });
  const besideThread = scopedThreadKey(threadRef) !== scopedThreadKey(JIRA_ISSUES_PANEL_REF);
  const shell = useThreadShell(besideThread ? threadRef : null);
  const allProjects = useProjects();
  const { breakDown, pendingIssueId } = useBreakDownJiraIssue();
  // Beside a thread whose shell has not arrived, there is no project to offer yet.
  if (access === "hidden" || (besideThread && shell === null)) return null;

  const pending = pendingIssueId === jiraIssueKeyOf(issue);
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

/** Where to add the token a breakdown needs, under the panel's own controls. */
export function JiraBreakdownNeedsTokenNote() {
  return (
    <p className="text-muted-foreground text-xs">
      Breaking this issue down needs your Jira token in{" "}
      <Link to="/settings/account" className="underline">
        Settings → Account
      </Link>
      , since you approve what it proposes with your own account.
    </p>
  );
}
