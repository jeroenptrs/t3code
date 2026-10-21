/**
 * Fork-only. Jira issues for one view, read through the Jira environment's reader identity: a
 * saved Jira filter by default, ad-hoc JQL when asked. Rows group by status category, narrow by
 * facets over what is loaded, and open in the page's own right panel.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { jiraIssueKeyOf } from "@t3tools/client-runtime/state/jira";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  JiraCapabilities,
  JiraIssueSummary,
  JiraSearchInput,
  JiraSearchResult,
  JiraStatusCategory,
} from "@t3tools/contracts";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  CalendarRangeIcon,
  ChevronDownIcon,
  CodeIcon,
  ExternalLinkIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";

import { JiraIcon } from "../components/Icons";
import { jiraIssueThreadProjects } from "../components/jira/jiraBreakdown.logic";
import { JiraIssueFacetsMenu, JiraViewPicker } from "../components/jira/JiraIssueListControls";
import { JiraIssueRow } from "../components/jira/JiraIssueRow";
import { JiraIssuesPageShell } from "../components/jira/JiraIssuesPageShell";
import {
  EMPTY_JIRA_FACET_SELECTION,
  collectJiraIssueFacets,
  groupJiraIssuesByStatusCategory,
  matchesJiraIssueFacets,
  mergeJiraSearchPages,
  personalCredentialForSite,
  readJiraIssuesViewId,
  sortJiraFilterViews,
  writeJiraIssuesViewId,
  type JiraIssueFacetSelection,
} from "../components/jira/jiraIssueList.logic";
import { jiraIssueWriteAccess } from "../components/jira/jiraIssueWrite.logic";
import { sharedJiraProjectKey } from "../components/jira/jiraPlanning.logic";
import { JIRA_STATUS_CATEGORY_LABEL, JiraStatusDot } from "../components/jira/jiraPresentation";
import { useBreakDownJiraIssue } from "../components/jira/useBreakDownJiraIssue";
import { useStartThreadFromJiraIssue } from "../components/jira/useStartThreadFromJiraIssue";
import { PullRequestListGhost } from "../components/pullRequest/PullRequestGhosts";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { RefreshIcon } from "../components/ui/refresh-icon";
import { Separator } from "../components/ui/separator";
import { Spinner } from "../components/ui/spinner";
import { toastManager } from "../components/ui/toast";
import { cn } from "../lib/utils";
import { jiraIssueSurface } from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useProjects } from "../state/entities";
import { jiraEnvironment, jiraFailureReason } from "../state/jira";
import { useEnvironmentQuery } from "../state/query";

export const Route = createFileRoute("/_chat/issues")({
  component: JiraIssuesRouteView,
});

/** Jira's own cap on one page. */
const PAGE_SIZE = 100;

const NO_PAGES: ReadonlyArray<JiraSearchResult> = [];

function JiraIssuesRouteView() {
  return (
    <JiraIssuesPageShell title="Issues" loadingCaption="Loading issues">
      {(context) => <JiraIssuesList {...context} />}
    </JiraIssuesPageShell>
  );
}

type JiraIssuesView =
  | { readonly kind: "filter"; readonly id: string }
  | {
      readonly kind: "jql";
      readonly jql: string;
    };

const viewKeyOf = (view: JiraIssuesView | null) =>
  view === null ? "none" : view.kind === "filter" ? `filter:${view.id}` : `jql:${view.jql}`;

function JiraIssuesList({
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
  const [chosenView, setChosenView] = useState<JiraIssuesView | null>(() => {
    const stored = readJiraIssuesViewId(environmentId);
    return stored === null ? null : { kind: "filter", id: stored };
  });
  const [jqlEditing, setJqlEditing] = useState(false);
  const [jqlDraft, setJqlDraft] = useState("");
  const [showJql, setShowJql] = useState(false);

  // With nothing remembered, the reader's first starred filter is the view.
  const defaultFiltersQuery = useEnvironmentQuery(
    chosenView === null ? jiraEnvironment.filters({ environmentId, input: {} }) : null,
  );
  const defaultFilter = sortJiraFilterViews(defaultFiltersQuery.data?.filters ?? [])[0] ?? null;
  const view: JiraIssuesView | null =
    chosenView ?? (defaultFilter === null ? null : { kind: "filter", id: defaultFilter.id });
  const viewKey = viewKeyOf(view);

  const viewFilterId = view?.kind === "filter" ? view.id : null;
  const viewJql = view?.kind === "jql" ? view.jql : null;
  const baseInput: JiraSearchInput | null =
    viewFilterId !== null
      ? { filterId: viewFilterId, maxResults: PAGE_SIZE }
      : viewJql !== null
        ? { jql: viewJql, maxResults: PAGE_SIZE }
        : null;
  const firstPage = useEnvironmentQuery(
    baseInput === null ? null : jiraEnvironment.search({ environmentId, input: baseInput }),
  );

  // Later pages, kept for the view they continue. Only a new view or an explicit refresh starts
  // over; a stale-time revalidation or reconnect of the first page keeps what the user loaded.
  const [refreshCount, setRefreshCount] = useState(0);
  const pagesKey = `${viewKey}#${refreshCount}`;
  const [more, setMore] = useState<{
    readonly pagesKey: string;
    readonly pages: ReadonlyArray<JiraSearchResult>;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const morePages = more !== null && more.pagesKey === pagesKey ? more.pages : NO_PAGES;
  const merged = mergeJiraSearchPages(
    firstPage.data === null ? [] : [firstPage.data, ...morePages],
  );

  const [facetSelection, setFacetSelection] = useState<JiraIssueFacetSelection>(
    EMPTY_JIRA_FACET_SELECTION,
  );
  const facets = collectJiraIssueFacets(merged.issues, facetSelection);
  const shownIssues = merged.issues.filter((issue) =>
    matchesJiraIssueFacets(issue, facetSelection),
  );
  const groups = groupJiraIssuesByStatusCategory(shownIssues);
  const planningProjectKey = sharedJiraProjectKey(merged.issues);
  const [collapsed, setCollapsed] = useState<Readonly<Record<JiraStatusCategory, boolean>>>({
    todo: false,
    "in-progress": false,
    done: true,
  });

  const canBreakDown = useAtomValue(jiraEnvironment.startBreakdown.permissionAtom(environmentId));
  const projects = jiraIssueThreadProjects(useProjects(), environmentId);
  const { start: startThreadFromIssue, startingKey } = useStartThreadFromJiraIssue(environmentId);
  const onStartThread = (issue: JiraIssueSummary, project: EnvironmentProject) =>
    void startThreadFromIssue(issue, scopeProjectRef(project.environmentId, project.id));
  const { breakDown, pendingIssueId: breakingDownId } = useBreakDownJiraIssue();
  const onBreakDown = (issue: JiraIssueSummary, project: EnvironmentProject) =>
    void breakDown(issue, scopeProjectRef(project.environmentId, project.id));

  const changeView = (next: JiraIssuesView) => {
    setChosenView(next);
    setFacetSelection(EMPTY_JIRA_FACET_SELECTION);
    if (next.kind === "filter") {
      writeJiraIssuesViewId(environmentId, next.id);
      setJqlEditing(false);
    }
  };
  const runJql = () => {
    const jql = jqlDraft.trim();
    if (jql.length > 0) changeView({ kind: "jql", jql: jql.slice(0, 4000) });
  };
  const refresh = () => {
    if (baseInput === null) return;
    setRefreshCount((count) => count + 1);
    setMore(null);
    jiraEnvironment.refreshSearch(appAtomRegistry, { environmentId, input: baseInput });
  };
  const loadMore = async () => {
    const token = merged.nextPageToken;
    const loadingKey = pagesKey;
    if (token === null || baseInput === null || loadingMore) return;
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
      pagesKey: loadingKey,
      pages: [
        ...(current !== null && current.pagesKey === loadingKey ? current.pages : []),
        result.value,
      ],
    }));
  };

  const filter = firstPage.data?.filter ?? null;
  const failureReason = firstPage.data === null ? jiraFailureReason(firstPage.failure) : null;
  const viewLabel =
    view === null
      ? "Choose a view"
      : view.kind === "jql"
        ? "JQL"
        : (filter?.name ?? (defaultFilter?.id === view.id ? defaultFilter.name : "Filter"));
  const jqlError =
    view?.kind === "jql" && failureReason === "invalid" ? (firstPage.error ?? null) : null;
  const refused = failureReason === "unauthorized" || failureReason === "forbidden";
  // Only a credential on the reader's site changes who reads; elsewhere the reader still does.
  const personalCredential = personalCredentialForSite(capabilities, capabilities.reader?.site);

  return (
    <>
      {personalCredential?.error != null ? (
        <Alert variant="error">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>Jira rejected your token</AlertTitle>
          <AlertDescription>{personalCredential.error}</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" render={<Link to="/settings/account" />}>
              Open Account settings
            </Button>
          </AlertAction>
        </Alert>
      ) : personalCredential === null && capabilities.readerError !== null ? (
        <Alert variant="error">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>Jira cannot read as {capabilities.reader?.name ?? "the reader"}</AlertTitle>
          <AlertDescription>{capabilities.readerError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <JiraViewPicker
            environmentId={environmentId}
            label={viewLabel}
            selectedFilterId={view?.kind === "filter" ? view.id : null}
            onSelectFilter={(id) => changeView({ kind: "filter", id })}
            onUseJql={() => {
              setJqlEditing(true);
              if (jqlDraft.length === 0 && filter !== null) setJqlDraft(filter.jql);
            }}
          />
          <JiraIssueFacetsMenu
            facets={facets}
            selection={facetSelection}
            onChange={setFacetSelection}
          />
          <div className="min-w-0 flex-1" />
          <Button
            size="sm"
            variant="outline"
            render={
              <Link
                to="/sprint-planning"
                search={planningProjectKey === null ? {} : { project: planningProjectKey }}
              />
            }
          >
            <CalendarRangeIcon aria-hidden />
            Plan sprint
          </Button>
          <Button
            size="icon"
            variant="outline"
            aria-label="Refresh issues"
            onClick={refresh}
            disabled={view === null || firstPage.isPending}
          >
            <RefreshIcon size="md" refreshing={firstPage.isPending} />
          </Button>
        </div>

        {jqlEditing || view?.kind === "jql" ? (
          <form
            className="flex flex-col gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              runJql();
            }}
          >
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  value={jqlDraft}
                  onChange={(event) => setJqlDraft(event.currentTarget.value)}
                  placeholder="project = ABC AND statusCategory != Done ORDER BY updated DESC"
                  aria-label="JQL"
                  aria-invalid={jqlError !== null ? true : undefined}
                  maxLength={4000}
                />
              </div>
              <Button type="submit" variant="outline" disabled={jqlDraft.trim().length === 0}>
                Run
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setJqlEditing(false);
                  if (view?.kind === "jql") {
                    const stored = readJiraIssuesViewId(environmentId);
                    setChosenView(stored === null ? null : { kind: "filter", id: stored });
                    setFacetSelection(EMPTY_JIRA_FACET_SELECTION);
                  }
                }}
              >
                Cancel
              </Button>
            </div>
            {jqlError !== null ? (
              <p role="alert" className="text-destructive-foreground text-xs">
                {jqlError}
              </p>
            ) : null}
          </form>
        ) : filter !== null ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <Button
                size="xs"
                variant="ghost"
                aria-expanded={showJql}
                onClick={() => setShowJql((value) => !value)}
              >
                <CodeIcon aria-hidden />
                {showJql ? "Hide JQL" : "Show JQL"}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                render={<a href={filter.url} target="_blank" rel="noopener noreferrer" />}
              >
                <ExternalLinkIcon aria-hidden />
                Open filter in Jira
              </Button>
            </div>
            {showJql ? (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 px-3 py-2 font-mono text-muted-foreground text-xs">
                {filter.jql}
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>

      {view === null ? (
        defaultFiltersQuery.data === null && defaultFiltersQuery.error === null ? (
          <PullRequestListGhost rows={7} caption="Loading your filters" />
        ) : (
          <Empty>
            <EmptyMedia variant="icon">
              <JiraIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>Choose a view</EmptyTitle>
              <EmptyDescription>
                {defaultFiltersQuery.error ??
                  "Search for a filter by name in the view picker, or use JQL."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      ) : firstPage.data === null && firstPage.error === null ? (
        <PullRequestListGhost rows={7} caption="Loading issues" />
      ) : firstPage.data === null ? (
        jqlError !== null ? null : (
          <Alert variant="error">
            <TriangleAlertIcon aria-hidden />
            <AlertTitle>
              {refused
                ? personalCredential === null
                  ? "Jira refused the reader"
                  : "Jira refused your token"
                : failureReason === "not-found"
                  ? "This filter is not available"
                  : "Could not load issues"}
            </AlertTitle>
            <AlertDescription>
              {refused
                ? personalCredential === null
                  ? `Jira refused the server's reader identity${capabilities.reader ? ` (${capabilities.reader.name})` : ""}. Check its token and project permissions.`
                  : "Check your token and project permissions in Settings → Account."
                : failureReason === "not-found"
                  ? "It was deleted, or the reader identity cannot see it. Choose another view."
                  : firstPage.error}
            </AlertDescription>
            <AlertAction>
              <Button size="xs" variant="outline" onClick={refresh} disabled={firstPage.isPending}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        )
      ) : merged.issues.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground text-sm">No issues in this view.</p>
      ) : (
        <div className="space-y-3">
          {firstPage.error !== null ? (
            <Alert variant="warning">
              <TriangleAlertIcon aria-hidden />
              <AlertDescription>{firstPage.error} Showing the issues loaded last.</AlertDescription>
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={refresh}
                  disabled={firstPage.isPending}
                >
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          ) : null}
          {shownIssues.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground text-sm">
              No loaded issues match these filters.
            </p>
          ) : null}
          {groups.map((group) =>
            group.issues.length === 0 ? null : (
              <section key={group.category} className="space-y-0.5">
                <JiraIssueGroupHeader
                  category={group.category}
                  count={group.issues.length}
                  expanded={!collapsed[group.category]}
                  onToggle={() =>
                    setCollapsed((current) => ({
                      ...current,
                      [group.category]: !current[group.category],
                    }))
                  }
                />
                {collapsed[group.category]
                  ? null
                  : group.issues.map((issue) => (
                      <JiraIssueRow
                        key={issue.key}
                        issue={issue}
                        selected={selectedIssueId === jiraIssueSurface(issue).id}
                        projects={projects}
                        starting={
                          startingKey === issue.key || breakingDownId === jiraIssueKeyOf(issue)
                        }
                        breakdown={jiraIssueWriteAccess({
                          capabilities,
                          canOperate: canBreakDown,
                          site: issue.site,
                        })}
                        onSelect={onSelectIssue}
                        onStartThread={onStartThread}
                        onBreakDown={onBreakDown}
                      />
                    ))}
              </section>
            ),
          )}
          {merged.nextPageToken !== null ? (
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
        </div>
      )}
    </>
  );
}

/** A group reads like the pull request list's: its dot, its name, how many, then a rule. */
function JiraIssueGroupHeader({
  category,
  count,
  expanded,
  onToggle,
}: {
  category: JiraStatusCategory;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-3 pb-1 text-left text-xs font-medium text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <JiraStatusDot category={category} />
      <h2 className="shrink-0">{JIRA_STATUS_CATEGORY_LABEL[category]}</h2>
      <span className="shrink-0 tabular-nums text-muted-foreground/50">{count}</span>
      <Separator className="min-w-2 flex-1" />
      <ChevronDownIcon aria-hidden className={cn("size-3 shrink-0", !expanded && "-rotate-90")} />
    </button>
  );
}
