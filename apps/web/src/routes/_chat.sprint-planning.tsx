/**
 * Fork-only. Plans one Jira project's sprints without an agent: velocity from its last closed
 * sprints, then each active and future sprint and the backlog as ordinary JQL searches. A user
 * with their own Jira token moves issues between them and estimates in place; rank, board setup
 * and the sprint lifecycle stay in Jira.
 */
import {
  executeAtomQuery,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  JiraCapabilities,
  JiraIssueSummary,
  JiraSearchInput,
  JiraSearchResult,
  JiraVelocityResult,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { JiraIcon } from "../components/Icons";
import { JiraIssuesPageShell } from "../components/jira/JiraIssuesPageShell";
import { mergeJiraSearchPages } from "../components/jira/jiraIssueList.logic";
import { jiraIssueWriteAccess } from "../components/jira/jiraIssueWrite.logic";
import {
  formatJiraPoints,
  formatJiraPointsTotal,
  jiraBacklogJql,
  jiraMoveTargets,
  jiraPlanningSections,
  jiraSprintSectionJql,
  jiraStoryPointsTotal,
  normalizeJiraProjectKey,
  sendJiraMove,
  type JiraMoveTarget,
  type JiraPlanningSection,
} from "../components/jira/jiraPlanning.logic";
import { JiraPlanningRow } from "../components/jira/JiraPlanningRow";
import { jiraProposalFailureMessage } from "../components/jira/jiraProposal.logic";
import { JiraStatusDot } from "../components/jira/jiraPresentation";
import { PullRequestListGhost } from "../components/pullRequest/PullRequestGhosts";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { RefreshIcon } from "../components/ui/refresh-icon";
import { Separator } from "../components/ui/separator";
import { Spinner } from "../components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { toastManager } from "../components/ui/toast";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { cn } from "../lib/utils";
import { jiraIssueSurface, setJiraIssuesPanelOnSprintPlanning } from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { jiraEnvironment, jiraFailureReason } from "../state/jira";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";

type SprintPlanningSearch = { readonly project?: string };

export const Route = createFileRoute("/_chat/sprint-planning")({
  validateSearch: (raw: Record<string, unknown>): SprintPlanningSearch => {
    const project = normalizeJiraProjectKey(typeof raw.project === "string" ? raw.project : null);
    return project === null ? {} : { project };
  },
  component: SprintPlanningRouteView,
});

/** Jira's own cap on one page. */
const PAGE_SIZE = 100;

const NO_PAGES: ReadonlyArray<JiraSearchResult> = [];
const LAST_PROJECT_STORAGE_KEY = "t3.jiraPlanning.project";
const LastProjectSchema = Schema.NullOr(Schema.String);

function SprintPlanningRouteView() {
  useEffect(() => {
    setJiraIssuesPanelOnSprintPlanning(true);
    return () => setJiraIssuesPanelOnSprintPlanning(false);
  }, []);
  return (
    <JiraIssuesPageShell title="Sprint planning" loadingCaption="Loading sprints">
      {(context) => <JiraSprintPlanning {...context} />}
    </JiraIssuesPageShell>
  );
}

function JiraSprintPlanning({
  environmentId,
  capabilities,
  selectedIssueId,
  onSelectIssue,
}: {
  environmentId: EnvironmentId;
  capabilities: JiraCapabilities;
  selectedIssueId: string | null;
  onSelectIssue: (issue: JiraIssueSummary) => void;
}) {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [lastProject, setLastProject] = useLocalStorage(
    LAST_PROJECT_STORAGE_KEY,
    null,
    LastProjectSchema,
  );
  const projectKey = search.project ?? normalizeJiraProjectKey(lastProject);
  const [draft, setDraft] = useState<string | null>(null);
  const draftText = draft ?? projectKey ?? "";
  const draftKey = normalizeJiraProjectKey(draftText);
  const draftInvalid = draft !== null && draft.trim().length > 0 && draftKey === null;
  const site = capabilities.reader?.site ?? null;

  const chooseProject = () => {
    if (draftKey === null) return;
    setDraft(null);
    setLastProject(draftKey);
    void navigate({ to: "/sprint-planning", search: { project: draftKey } });
  };

  return (
    <>
      <form
        className="flex flex-col gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          chooseProject();
        }}
      >
        <div className="flex items-center gap-2">
          <div className="w-48">
            <Input
              value={draftText}
              onChange={(event) => setDraft(event.currentTarget.value)}
              placeholder="Project key, such as ABC"
              aria-label="Jira project key"
              aria-invalid={draftInvalid ? true : undefined}
              maxLength={100}
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            disabled={draftKey === null || draftKey === projectKey}
          >
            Plan
          </Button>
        </div>
        {draftInvalid ? (
          <p role="alert" className="text-destructive-foreground text-xs">
            A project key is a letter followed by letters, digits or underscores.
          </p>
        ) : null}
      </form>

      {site === null ? (
        <Alert variant="error">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>Jira has no reader site</AlertTitle>
          <AlertDescription>
            Sprint planning reads the reader identity's site, and this server has none.
          </AlertDescription>
        </Alert>
      ) : projectKey === null ? (
        <Empty>
          <EmptyMedia variant="icon">
            <JiraIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>Choose a project</EmptyTitle>
            <EmptyDescription>
              Enter the key of the Jira project on {site} whose sprints you want to plan.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <JiraProjectPlan
          key={`${site}/${projectKey}`}
          environmentId={environmentId}
          capabilities={capabilities}
          site={site}
          projectKey={projectKey}
          selectedIssueId={selectedIssueId}
          onSelectIssue={onSelectIssue}
        />
      )}
    </>
  );
}

const sectionSearchInput = (projectKey: string, section: JiraPlanningSection): JiraSearchInput => ({
  jql:
    section.kind === "sprint"
      ? jiraSprintSectionJql(projectKey, section.sprint.id)
      : jiraBacklogJql(projectKey),
  maxResults: PAGE_SIZE,
});

/** The sections a user is most likely planning between start open; the rest read when opened. */
function openByDefault(section: JiraPlanningSection, sections: ReadonlyArray<JiraPlanningSection>) {
  if (section.kind === "backlog") return true;
  if (section.sprint.state === "active") return true;
  const firstFuture = sections.find(
    (candidate) => candidate.kind === "sprint" && candidate.sprint.state === "future",
  );
  return firstFuture?.id === section.id;
}

function JiraProjectPlan({
  environmentId,
  capabilities,
  site,
  projectKey,
  selectedIssueId,
  onSelectIssue,
}: {
  environmentId: EnvironmentId;
  capabilities: JiraCapabilities;
  site: string;
  projectKey: string;
  selectedIssueId: string | null;
  onSelectIssue: (issue: JiraIssueSummary) => void;
}) {
  const target = { environmentId, input: { site, projectKey } };
  const sprintsQuery = useEnvironmentQuery(jiraEnvironment.sprints(target));
  const velocityQuery = useEnvironmentQuery(jiraEnvironment.velocity(target));
  const canMove = useAtomValue(jiraEnvironment.setSprint.permissionAtom(environmentId));
  const canEstimate = useAtomValue(jiraEnvironment.setStoryPoints.permissionAtom(environmentId));
  const writeAccess = jiraIssueWriteAccess({
    capabilities,
    canOperate: canMove && canEstimate,
    site,
  });
  const writable = writeAccess === "enabled";

  const sprints = sprintsQuery.data?.sprints ?? [];
  const sections = jiraPlanningSections(sprints);
  const moveTargets = jiraMoveTargets(sprints);

  const [expandedById, setExpandedById] = useState<Readonly<Record<string, boolean>>>({});
  // A section that has been opened keeps reading, so its header keeps its count when collapsed.
  const [openedIds, setOpenedIds] = useState<ReadonlySet<string>>(() => new Set());
  const isExpanded = (section: JiraPlanningSection) =>
    expandedById[section.id] ?? openByDefault(section, sections);
  const unopened = sections.filter((section) => isExpanded(section) && !openedIds.has(section.id));
  if (unopened.length > 0) {
    setOpenedIds(new Set([...openedIds, ...unopened.map((section) => section.id)]));
  }

  // Bumped when a section's issues changed, so it drops pages loaded before the change.
  const [revisions, setRevisions] = useState<Readonly<Record<string, number>>>({});
  const refreshSections = (ids: Iterable<string>) => {
    const refreshed = sections.filter(
      (section) => openedIds.has(section.id) && [...ids].includes(section.id),
    );
    for (const section of refreshed) {
      jiraEnvironment.refreshSearch(appAtomRegistry, {
        environmentId,
        input: sectionSearchInput(projectKey, section),
      });
    }
    // Functional, since a move refreshes after awaiting Jira.
    setRevisions((current) => {
      const next = { ...current };
      for (const section of refreshed) next[section.id] = (next[section.id] ?? 0) + 1;
      return next;
    });
  };
  const refreshAll = () => {
    jiraEnvironment.refreshSprints(appAtomRegistry, target);
    jiraEnvironment.refreshVelocity(appAtomRegistry, target);
    refreshSections(openedIds);
  };

  // Selected issue keys, each with the section it was selected in, which a move re-reads.
  const [selection, setSelection] = useState<ReadonlyMap<string, string>>(() => new Map());
  const toggleSelected = (sectionId: string, issueKey: string, selected: boolean) =>
    setSelection((current) => {
      const next = new Map(current);
      if (selected) next.set(issueKey, sectionId);
      else next.delete(issueKey);
      return next;
    });

  const setSprint = useAtomCommand(jiraEnvironment.setSprint, {
    label: "move Jira issues",
    // A move reports its failures, partial ones included, in one toast below.
    reportFailure: false,
  });
  const [moving, setMoving] = useState(false);
  const movingRef = useRef(false);
  const move = async (moveTarget: JiraMoveTarget) => {
    const moved = selection;
    if (moved.size === 0 || movingRef.current) return;
    movingRef.current = true;
    setMoving(true);
    const { updated, failed, attempted, stopped } = await sendJiraMove(
      [...moved.keys()],
      async (keys) => {
        const result = await setSprint({
          environmentId,
          input: { site, keys, sprintId: moveTarget.sprintId },
        });
        return result._tag === "Success"
          ? { ok: true, result: result.value }
          : {
              ok: false,
              message: isAtomCommandInterrupted(result)
                ? "The move was interrupted."
                : jiraProposalFailureMessage(squashAtomCommandFailure(result)),
            };
      },
    );
    movingRef.current = false;
    setMoving(false);

    const targetSection = sections.find((section) =>
      moveTarget.sprintId === null
        ? section.kind === "backlog"
        : section.kind === "sprint" && section.sprint.id === moveTarget.sprintId,
    );
    // A chunk that failed whole may still have moved some of its issues before Jira refused.
    const written = stopped === null ? updated : attempted;
    const touched = new Set(written.flatMap((key) => moved.get(key) ?? []));
    if (targetSection !== undefined && written.length > 0) touched.add(targetSection.id);
    refreshSections(touched);
    setSelection((current) => {
      const remaining = new Map(current);
      for (const key of updated) remaining.delete(key);
      return remaining;
    });

    const notMoved = moved.size - updated.length;
    if (notMoved === 0) {
      toastManager.add({
        type: "success",
        title: `Moved ${updated.length} ${updated.length === 1 ? "issue" : "issues"} to ${moveTarget.label}`,
      });
    } else {
      toastManager.add({
        type: "error",
        title:
          updated.length === 0
            ? `Could not move ${notMoved === 1 ? "the issue" : `${notMoved} issues`}`
            : `Moved ${updated.length}, could not move ${notMoved}`,
        description: [
          ...(stopped === null ? [] : [stopped]),
          ...failed.map((failure) => `${failure.key}: ${failure.message}`),
        ].join("\n"),
      });
    }
  };

  const setStoryPoints = useAtomCommand(jiraEnvironment.setStoryPoints, {
    label: "estimate Jira issue",
    reportFailure: false,
  });
  const commitStoryPoints = async (issue: JiraIssueSummary, storyPoints: number | null) => {
    const result = await setStoryPoints({
      environmentId,
      input: { site: issue.site, key: issue.key, storyPoints },
    });
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: `Could not estimate ${issue.key}`,
        description: jiraProposalFailureMessage(squashAtomCommandFailure(result)),
      });
    }
    return false;
  };

  const sprintsFailure = sprintsQuery.data === null ? sprintsQuery.failure : null;
  const refused =
    jiraFailureReason(sprintsFailure) === "unauthorized" ||
    jiraFailureReason(sprintsFailure) === "forbidden";

  return (
    <>
      <JiraVelocitySummary
        projectKey={projectKey}
        velocity={velocityQuery.data}
        error={velocityQuery.data === null ? velocityQuery.error : null}
      />

      {writeAccess === "needs-token" ? (
        <p className="text-muted-foreground text-xs">
          Moving and estimating issues as yourself needs your Jira token in{" "}
          <Link to="/settings/account" className="underline">
            Settings → Account
          </Link>
          . Until then this plan is read-only.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {writable ? (
          <>
            <span className="text-muted-foreground text-sm tabular-nums">
              {selection.size === 0 ? "Select issues to move them" : `${selection.size} selected`}
            </span>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={selection.size === 0 || moving}
                    aria-busy={moving}
                  >
                    {moving ? "Moving…" : "Move to"}
                    <ChevronDownIcon aria-hidden />
                  </Button>
                }
              />
              <MenuPopup align="start">
                {moveTargets.map((moveTarget) => (
                  <MenuItem
                    key={moveTarget.sprintId ?? "backlog"}
                    onClick={() => void move(moveTarget)}
                  >
                    {moveTarget.label}
                    {moveTarget.state === "active" ? (
                      <Badge variant="info" size="sm">
                        Active
                      </Badge>
                    ) : null}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
            {selection.size > 0 ? (
              <Button size="sm" variant="ghost" onClick={() => setSelection(new Map())}>
                Clear
              </Button>
            ) : null}
          </>
        ) : null}
        <div className="min-w-0 flex-1" />
        <Button
          size="icon"
          variant="outline"
          aria-label="Refresh plan"
          onClick={refreshAll}
          disabled={sprintsQuery.isPending}
        >
          <RefreshIcon size="md" refreshing={sprintsQuery.isPending} />
        </Button>
      </div>

      {sprintsQuery.data === null && sprintsQuery.error === null ? (
        <PullRequestListGhost rows={7} caption="Loading sprints" />
      ) : sprintsQuery.data === null ? (
        <Alert variant="error">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>
            {refused
              ? "Jira refused to list this project's sprints"
              : jiraFailureReason(sprintsFailure) === "not-found"
                ? `Project ${projectKey} is not available`
                : "Could not load sprints"}
          </AlertTitle>
          <AlertDescription>
            {refused
              ? "Check the token's project permissions."
              : jiraFailureReason(sprintsFailure) === "not-found"
                ? "It does not exist, or Jira does not show it to you. Check the key."
                : sprintsQuery.error}
          </AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={refreshAll}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : (
        <div className="space-y-3">
          {sections.map((section) => (
            <JiraPlanningSectionView
              key={section.id}
              environmentId={environmentId}
              projectKey={projectKey}
              section={section}
              expanded={isExpanded(section)}
              opened={openedIds.has(section.id)}
              revision={revisions[section.id] ?? 0}
              writable={writable}
              selection={selection}
              selectedIssueId={selectedIssueId}
              onToggleExpanded={() =>
                setExpandedById({ ...expandedById, [section.id]: !isExpanded(section) })
              }
              onSelectIssue={onSelectIssue}
              onToggleSelected={toggleSelected}
              onCommitStoryPoints={commitStoryPoints}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** Average and per-sprint points, as text: a plan needs the numbers, not a chart. */
function JiraVelocitySummary({
  projectKey,
  velocity,
  error,
}: {
  projectKey: string;
  velocity: JiraVelocityResult | null;
  error: string | null;
}) {
  if (velocity === null) {
    return error === null ? (
      <p className="flex items-center gap-2 text-muted-foreground text-sm">
        <Spinner aria-hidden size="sm" />
        Reading {projectKey}'s velocity
      </p>
    ) : (
      <p className="text-muted-foreground text-sm">Velocity is unavailable: {error}</p>
    );
  }
  if (velocity.sprints.length === 0) {
    return <p className="text-muted-foreground text-sm">{projectKey} has no closed sprints yet.</p>;
  }
  return (
    <section className="flex flex-col gap-2" aria-label="Velocity">
      <p className="text-sm">
        <span className="font-medium tabular-nums">
          {velocity.averageCompletedPoints === null
            ? "–"
            : `${formatJiraPoints(velocity.averageCompletedPoints)} pt`}
        </span>{" "}
        <span className="text-muted-foreground">
          completed per sprint on average over the last{" "}
          {velocity.sprints.length === 1
            ? "closed sprint"
            : `${velocity.sprints.length} closed sprints`}
          {velocity.partial ? " (partial: older sprints may be undercounted)" : ""}
        </span>
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Sprint</TableHead>
            <TableHead>Committed</TableHead>
            <TableHead>Completed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {velocity.sprints.map((entry) => (
            <TableRow key={entry.sprint.id}>
              <TableCell>{entry.sprint.name}</TableCell>
              <TableCell>
                <span className="tabular-nums">{formatJiraPoints(entry.committedPoints)} pt</span>
              </TableCell>
              <TableCell>
                <span className="tabular-nums">{formatJiraPoints(entry.completedPoints)} pt</span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

const formatSprintDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function JiraPlanningSectionView({
  environmentId,
  projectKey,
  section,
  expanded,
  opened,
  revision,
  writable,
  selection,
  selectedIssueId,
  onToggleExpanded,
  onSelectIssue,
  onToggleSelected,
  onCommitStoryPoints,
}: {
  environmentId: EnvironmentId;
  projectKey: string;
  section: JiraPlanningSection;
  expanded: boolean;
  /** Read while true; collapsing an opened section keeps what it read. */
  opened: boolean;
  revision: number;
  writable: boolean;
  selection: ReadonlyMap<string, string>;
  selectedIssueId: string | null;
  onToggleExpanded: () => void;
  onSelectIssue: (issue: JiraIssueSummary) => void;
  onToggleSelected: (sectionId: string, issueKey: string, selected: boolean) => void;
  onCommitStoryPoints: (issue: JiraIssueSummary, storyPoints: number | null) => Promise<boolean>;
}) {
  const baseInput = sectionSearchInput(projectKey, section);
  const firstPage = useEnvironmentQuery(
    opened ? jiraEnvironment.search({ environmentId, input: baseInput }) : null,
  );

  // Later pages, kept until a write to this section bumps its revision.
  const [more, setMore] = useState<{
    readonly revision: number;
    readonly pages: ReadonlyArray<JiraSearchResult>;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const morePages = more !== null && more.revision === revision ? more.pages : NO_PAGES;
  const merged = mergeJiraSearchPages(
    firstPage.data === null ? [] : [firstPage.data, ...morePages],
  );
  const total = jiraStoryPointsTotal(merged.issues);
  const hasMore = merged.nextPageToken !== null;

  const loadMore = async () => {
    const token = merged.nextPageToken;
    const loadingRevision = revision;
    if (token === null || loadingMore) return;
    setLoadingMore(true);
    const result = await executeAtomQuery(
      appAtomRegistry,
      jiraEnvironment.search({ environmentId, input: { ...baseInput, nextPageToken: token } }),
      { reportFailure: false },
    );
    setLoadingMore(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not load more issues" });
      return;
    }
    setMore((current) => ({
      revision: loadingRevision,
      pages: [
        ...(current !== null && current.revision === loadingRevision ? current.pages : []),
        result.value,
      ],
    }));
  };

  // An estimate changes one row, so only the page that holds it is read again; later pages
  // stay loaded, which a whole-section refresh would drop.
  const rereadPageOf = async (issueKey: string) => {
    const pageIndex = morePages.findIndex((page) =>
      page.issues.some((issue) => issue.key === issueKey),
    );
    if (pageIndex === -1) {
      jiraEnvironment.refreshSearch(appAtomRegistry, { environmentId, input: baseInput });
      return;
    }
    const token = (pageIndex === 0 ? firstPage.data : morePages[pageIndex - 1])?.nextPageToken;
    if (token == null) return;
    const loadingRevision = revision;
    const result = await executeAtomQuery(
      appAtomRegistry,
      jiraEnvironment.search({ environmentId, input: { ...baseInput, nextPageToken: token } }),
      { refresh: true, reportFailure: false },
    );
    if (result._tag === "Failure") return;
    setMore((current) =>
      current === null || current.revision !== loadingRevision
        ? current
        : {
            revision: loadingRevision,
            pages: current.pages.map((page, index) => (index === pageIndex ? result.value : page)),
          },
    );
  };
  const commitStoryPoints = async (issue: JiraIssueSummary, storyPoints: number | null) => {
    const ok = await onCommitStoryPoints(issue, storyPoints);
    if (ok) void rereadPageOf(issue.key);
    return ok;
  };

  const sprint = section.kind === "sprint" ? section.sprint : null;
  const loaded = firstPage.data !== null;
  return (
    <section className="space-y-0.5">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggleExpanded}
        className="flex w-full cursor-pointer items-center gap-2 rounded-md px-3 pb-1 text-left text-xs font-medium text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <JiraStatusDot
          category={sprint === null ? null : sprint.state === "active" ? "in-progress" : "todo"}
        />
        <h2 className="min-w-0 truncate">{sprint === null ? "Backlog" : sprint.name}</h2>
        {sprint !== null ? (
          <span className="shrink-0">{sprint.state === "active" ? "Active" : "Future"}</span>
        ) : null}
        {sprint?.startDate != null || sprint?.endDate != null ? (
          <span className="shrink-0 tabular-nums">
            {sprint.startDate == null ? "?" : formatSprintDate(sprint.startDate)} –{" "}
            {sprint.endDate == null ? "?" : formatSprintDate(sprint.endDate)}
          </span>
        ) : null}
        {loaded ? (
          <span className="shrink-0 tabular-nums text-muted-foreground/50">
            {merged.issues.length}
            {hasMore ? "+" : ""} {merged.issues.length === 1 && !hasMore ? "issue" : "issues"} ·{" "}
            {formatJiraPointsTotal(total.points, hasMore)}
          </span>
        ) : firstPage.isPending ? (
          <Spinner aria-hidden size="sm" />
        ) : null}
        <Separator className="min-w-2 flex-1" />
        <ChevronDownIcon aria-hidden className={cn("size-3 shrink-0", !expanded && "-rotate-90")} />
      </button>
      {!expanded ? null : firstPage.data === null && firstPage.error === null ? (
        <PullRequestListGhost rows={3} caption="Loading issues" />
      ) : firstPage.data === null ? (
        <Alert variant="error">
          <TriangleAlertIcon aria-hidden />
          <AlertDescription>{firstPage.error}</AlertDescription>
          <AlertAction>
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                jiraEnvironment.refreshSearch(appAtomRegistry, { environmentId, input: baseInput })
              }
              disabled={firstPage.isPending}
            >
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : merged.issues.length === 0 ? (
        <p className="px-3 py-3 text-muted-foreground text-sm">
          {sprint === null ? "The backlog is empty." : "No issues in this sprint."}
        </p>
      ) : (
        <>
          {merged.issues.map((issue) => (
            <JiraPlanningRow
              key={issue.key}
              sectionId={section.id}
              issue={issue}
              opened={selectedIssueId === jiraIssueSurface(issue).id}
              selected={selection.has(issue.key)}
              writable={writable}
              onOpen={onSelectIssue}
              onToggleSelected={onToggleSelected}
              onCommitStoryPoints={commitStoryPoints}
            />
          ))}
          {hasMore ? (
            <div className="flex justify-center py-3">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? <Spinner aria-hidden size="sm" /> : null}
                Load more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
