/**
 * Fork-only. Jira issues for one view, read through the Jira environment's reader identity: a
 * saved Jira filter by default, ad-hoc JQL when asked. Rows group by status category, narrow by
 * facets over what is loaded, and open in the page's own right panel.
 */
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
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
import { useAtomValue } from "@effect/atom-react";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDownIcon, CodeIcon, ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { JiraIcon } from "../components/Icons";
import { JiraIssueDetailPanel } from "../components/jira/JiraIssueDetailPanel";
import { JiraIssueFacetsMenu, JiraViewPicker } from "../components/jira/JiraIssueListControls";
import { JiraIssueRow } from "../components/jira/JiraIssueRow";
import {
  EMPTY_JIRA_FACET_SELECTION,
  collectJiraIssueFacets,
  groupJiraIssuesByStatusCategory,
  matchesJiraIssueFacets,
  mergeJiraSearchPages,
  readJiraIssuesViewId,
  sortJiraFilterViews,
  writeJiraIssuesViewId,
  type JiraIssueFacetSelection,
} from "../components/jira/jiraIssueList.logic";
import {
  JIRA_STATUS_CATEGORY_LABEL,
  JiraConfigurationSteps,
  JiraStatusDot,
} from "../components/jira/jiraPresentation";
import { useStartThreadFromJiraIssue } from "../components/jira/useStartThreadFromJiraIssue";
import {
  PanelLayoutControls,
  RightPanelMaximizeControl,
} from "../components/chat/PanelLayoutControls";
import { PullRequestListGhost } from "../components/pullRequest/PullRequestGhosts";
import { RightPanelTabs } from "../components/RightPanelTabs";
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
import { SidebarInset } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { toastManager } from "../components/ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useEscapeToGoBack } from "../hooks/useNavigateBack";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { cn } from "../lib/utils";
import { usePanelAnimationSettings, usePanelPresence } from "../panelAnimations";
import {
  JIRA_ISSUES_PANEL_REF,
  jiraIssueSurface,
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
  type JiraIssueSurface,
  type RightPanelSurface,
} from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useProjects } from "../state/entities";
import {
  jiraEnvironment,
  jiraFailureReason,
  useJiraCapabilities,
  useJiraEnvironmentId,
} from "../state/jira";
import { useEnvironmentQuery } from "../state/query";
import { primaryServerKeybindingsAtom } from "../state/server";

export const Route = createFileRoute("/_chat/issues")({
  component: JiraIssuesRouteView,
});

/** Jira's own cap on one page. */
const PAGE_SIZE = 100;

const NO_PAGES: ReadonlyArray<JiraSearchResult> = [];
const EMPTY_PENDING_SURFACES = new Set<string>();
const EMPTY_PREVIEW_SESSIONS = {};
const EMPTY_PREVIEW_DESKTOP_STATE = {};
const EMPTY_TERMINAL_LABELS = new Map<string, string>();

function getShortcutContext() {
  return {
    terminalFocus: isTerminalFocused(),
    terminalOpen: false,
    previewFocus: false,
    previewOpen: false,
    modelPickerOpen: false,
    isWeb: !isElectron,
    isDesktop: isElectron,
  };
}

const isJiraIssueSurface = (surface: RightPanelSurface | null): surface is JiraIssueSurface =>
  surface?.kind === "jira-issue";

function JiraIssuesRouteView() {
  useEscapeToGoBack();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const environmentId = useJiraEnvironmentId();
  const capabilities = useJiraCapabilities(environmentId);
  const configured = capabilities?.configured === true && environmentId !== null;

  const rightPanelRef = JIRA_ISSUES_PANEL_REF;
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, rightPanelRef),
  );
  const selectedSurface = useRightPanelStore((state) =>
    selectSelectedRightPanelSurface(state.byThreadKey, rightPanelRef),
  );
  const selectedIssueSurface = isJiraIssueSurface(selectedSurface) ? selectedSurface : null;
  const activeIssueSurface = rightPanelState.isOpen ? selectedIssueSurface : null;
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const presenceValue = useMemo(
    () => ({ activeSurface: selectedIssueSurface, surfaces: rightPanelState.surfaces }),
    [rightPanelState.surfaces, selectedIssueSurface],
  );
  const presence = usePanelPresence(
    configured && rightPanelState.isOpen && selectedIssueSurface !== null,
    presenceValue,
    panelAnimationsActive,
    rightPanelRef.threadId,
    panelAnimationDurationMs,
  );
  const renderedIssueSurface = presence.value?.activeSurface ?? null;
  const [maximized, setMaximized] = useState(false);
  const rightPanelMaximized = rightPanelState.isOpen && maximized;
  if (!rightPanelState.isOpen && maximized) setMaximized(false);
  const toggleRightPanelMaximized = () => {
    if (rightPanelState.isOpen) setMaximized((value) => !value);
  };
  const toggleRightPanel = () => {
    const store = useRightPanelStore.getState();
    if (rightPanelState.isOpen) store.close(rightPanelRef);
    else if (selectedIssueSurface !== null) store.show(rightPanelRef);
  };

  const selectIssue = useCallback(
    (issue: JiraIssueSummary) =>
      useRightPanelStore.getState().openJiraIssue(JIRA_ISSUES_PANEL_REF, issue),
    [],
  );

  // This page has no ChatView, so it handles the shared panel shortcuts itself.
  const onPanelShortcut = useEffectEvent((event: KeyboardEvent, command: string | null) => {
    const store = useRightPanelStore.getState();
    if (command === "rightPanel.close" && activeIssueSurface !== null) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) store.closeSurface(rightPanelRef, activeIssueSurface.id);
    } else if (command === "rightPanel.toggle" && selectedIssueSurface !== null) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggleRightPanel();
    } else if (command === "rightPanel.toggleMaximized" && rightPanelState.isOpen) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggleRightPanelMaximized();
    }
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isCommandPaletteOpen()) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: getShortcutContext(),
      });
      onPanelShortcut(event, command);
    };
    // Let panel shortcuts consume Escape before page navigation at window.
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);

  const openPanelControls = configured ? (
    <div
      className="absolute top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]"
      data-workspace-titlebar-controls
    >
      {rightPanelState.isOpen ? (
        <RightPanelMaximizeControl
          maximized={rightPanelMaximized}
          onToggle={toggleRightPanelMaximized}
        />
      ) : null}
      <PanelLayoutControls
        showTerminalControl={false}
        showThreadPanelControl={false}
        terminalAvailable={false}
        terminalOpen={false}
        terminalShortcutLabel={null}
        threadPanelOpen={false}
        threadPanelPresentation="inline"
        threadPanelShortcutLabel={null}
        onToggleThreadPanel={() => undefined}
        rightPanelAvailable={selectedIssueSurface !== null}
        rightPanelOpen={rightPanelState.isOpen}
        rightPanelShortcutLabel={shortcutLabelForCommand(keybindings, "rightPanel.toggle")}
        rightPanelUnavailableLabel="Select an issue first"
        onToggleTerminal={() => undefined}
        onToggleRightPanel={toggleRightPanel}
      />
    </div>
  ) : null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="relative flex min-h-0 flex-1">
        {presence.present ? openPanelControls : null}
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-col overflow-x-hidden bg-background",
            rightPanelMaximized ? "w-0 flex-none" : "flex-1",
          )}
        >
          <WorkspacePageHeader
            electron={isElectron}
            reserveNativeControls={!rightPanelState.isOpen}
            className="relative bg-background"
          >
            {presence.present ? null : openPanelControls}
            <WorkspaceBreadcrumb ariaLabel="Issues breadcrumb">
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">Issues</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </WorkspacePageHeader>
          <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
            <WorkspacePageContainer width="expanded" className="min-h-full gap-4">
              {capabilities === null || environmentId === null ? (
                <PullRequestListGhost rows={7} caption="Loading issues" />
              ) : !capabilities.configured ? (
                <JiraNotConfiguredState />
              ) : (
                <JiraIssuesList
                  key={environmentId}
                  environmentId={environmentId}
                  capabilities={capabilities}
                  selectedIssueId={activeIssueSurface?.id ?? null}
                  onSelectIssue={selectIssue}
                />
              )}
            </WorkspacePageContainer>
          </div>
        </div>

        {presence.present && renderedIssueSurface !== null && environmentId !== null ? (
          <RightPanelTabs
            mode="inline"
            open={rightPanelState.isOpen}
            maximized={rightPanelMaximized}
            keybindings={keybindings}
            getShortcutContext={getShortcutContext}
            widthStorageKey="t3code:jira-issue-panel-width"
            defaultWidth={typeof window === "undefined" ? 560 : Math.floor(window.innerWidth / 2)}
            surfaces={presence.value?.surfaces ?? []}
            environmentId={environmentId}
            activeSurfaceId={renderedIssueSurface.id}
            pendingSurfaceIds={EMPTY_PENDING_SURFACES}
            previewSessions={EMPTY_PREVIEW_SESSIONS}
            desktopByTabId={EMPTY_PREVIEW_DESKTOP_STATE}
            terminalLabelsById={EMPTY_TERMINAL_LABELS}
            onActivate={(surface) =>
              useRightPanelStore.getState().activateSurface(rightPanelRef, surface.id)
            }
            onCloseSurface={(surface) =>
              useRightPanelStore.getState().closeSurface(rightPanelRef, surface.id)
            }
            onCloseOtherSurfaces={(surface) =>
              useRightPanelStore.getState().closeOtherSurfaces(rightPanelRef, surface.id)
            }
            onCloseSurfacesToRight={(surface) =>
              useRightPanelStore.getState().closeSurfacesToRight(rightPanelRef, surface.id)
            }
            onCloseAllSurfaces={() => useRightPanelStore.getState().closeAllSurfaces(rightPanelRef)}
            onMoveSurface={(surfaceId, toIndex) =>
              useRightPanelStore.getState().moveSurface(rightPanelRef, surfaceId, toIndex)
            }
            onCopyFilePath={() => undefined}
            onAddBrowser={() => undefined}
            onAddBrowserInProfile={() => undefined}
            onAddTerminal={() => undefined}
            onAddDiff={() => undefined}
            onAddFiles={() => undefined}
            onAddPullRequest={() => undefined}
            onAddPullRequests={() => undefined}
            onAddDevice={() => undefined}
            browserAvailable={false}
            terminalAvailable={false}
            diffAvailable={false}
            filesAvailable={false}
            pullRequestAvailable={false}
            pullRequestsAvailable={false}
            deviceAvailable={false}
          >
            <JiraIssueDetailPanel
              key={renderedIssueSurface.id}
              environmentId={environmentId}
              threadRef={rightPanelRef}
              issue={renderedIssueSurface}
            />
          </RightPanelTabs>
        ) : null}
      </div>
    </SidebarInset>
  );
}

function JiraNotConfiguredState() {
  return (
    <Empty>
      <EmptyMedia variant="icon">
        <JiraIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>Jira is not configured</EmptyTitle>
        <EmptyDescription>
          This server has no Jira identity to list issues with. <JiraConfigurationSteps />
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
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
  const baseInput = useMemo(
    (): JiraSearchInput | null =>
      viewFilterId !== null
        ? { filterId: viewFilterId, maxResults: PAGE_SIZE }
        : viewJql !== null
          ? { jql: viewJql, maxResults: PAGE_SIZE }
          : null,
    [viewFilterId, viewJql],
  );
  const firstPage = useEnvironmentQuery(
    baseInput === null ? null : jiraEnvironment.search({ environmentId, input: baseInput }),
  );

  // Later pages, for the view and first page they continued. A new view or a refreshed first
  // page starts over, since a page token only means something after the page that issued it.
  const [more, setMore] = useState<{
    readonly viewKey: string;
    readonly after: JiraSearchResult;
    readonly pages: ReadonlyArray<JiraSearchResult>;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const morePages =
    more !== null && more.viewKey === viewKey && more.after === firstPage.data
      ? more.pages
      : NO_PAGES;
  const merged = useMemo(
    () => mergeJiraSearchPages(firstPage.data === null ? [] : [firstPage.data, ...morePages]),
    [firstPage.data, morePages],
  );

  const [facetSelection, setFacetSelection] = useState<JiraIssueFacetSelection>(
    EMPTY_JIRA_FACET_SELECTION,
  );
  const facets = useMemo(
    () => collectJiraIssueFacets(merged.issues, facetSelection),
    [facetSelection, merged.issues],
  );
  const shownIssues = useMemo(
    () => merged.issues.filter((issue) => matchesJiraIssueFacets(issue, facetSelection)),
    [facetSelection, merged.issues],
  );
  const groups = useMemo(() => groupJiraIssuesByStatusCategory(shownIssues), [shownIssues]);
  const [collapsed, setCollapsed] = useState<Readonly<Record<JiraStatusCategory, boolean>>>({
    todo: false,
    "in-progress": false,
    done: true,
  });

  const allProjects = useProjects();
  // The thread runs where the reader is configured, so its branch detector can link the issue.
  const projects = useMemo(
    () =>
      allProjects
        .filter((project) => project.environmentId === environmentId)
        .toSorted((left, right) => left.title.localeCompare(right.title)),
    [allProjects, environmentId],
  );
  const { start: startThreadFromIssue, startingKey } = useStartThreadFromJiraIssue(environmentId);
  const onStartThread = useCallback(
    (issue: JiraIssueSummary, project: EnvironmentProject) =>
      void startThreadFromIssue(issue, scopeProjectRef(project.environmentId, project.id)),
    [startThreadFromIssue],
  );

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
    setMore(null);
    firstPage.refresh();
  };
  const loadMore = async () => {
    const token = merged.nextPageToken;
    const after = firstPage.data;
    if (token === null || baseInput === null || after === null || loadingMore) return;
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
      viewKey,
      after,
      pages: [
        ...(current !== null && current.viewKey === viewKey && current.after === after
          ? current.pages
          : []),
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

  return (
    <>
      {capabilities.readerError !== null ? (
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
                  "Star a filter in Jira, find one by name in the view picker, or use JQL."}
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
                ? "Jira refused the reader"
                : failureReason === "not-found"
                  ? "This filter is not available"
                  : "Could not load issues"}
            </AlertTitle>
            <AlertDescription>
              {refused
                ? `Jira refused the server's reader identity${capabilities.reader ? ` (${capabilities.reader.name})` : ""}. Check its token and project permissions.`
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
                        starting={startingKey === issue.key}
                        onSelect={onSelectIssue}
                        onStartThread={onStartThread}
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
