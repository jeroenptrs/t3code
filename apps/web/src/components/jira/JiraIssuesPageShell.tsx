/**
 * Fork-only. The frame the workspace Jira pages share: the Jira environment's capabilities, a
 * header, and the right panel that issues open in. Both pages use the `/issues` panel, so an issue
 * opened on one is still open on the other.
 */
import type { EnvironmentId, JiraCapabilities, JiraIssueSummary } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Fragment, useEffect, useEffectEvent, useState, type ReactNode } from "react";

import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { isElectron } from "~/env";
import { resolveShortcutCommand, shortcutLabelForCommand } from "~/keybindings";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { cn } from "~/lib/utils";
import { usePanelAnimationSettings, usePanelPresence } from "~/panelAnimations";
import {
  JIRA_ISSUES_PANEL_REF,
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
  type JiraIssueSurface,
  type RightPanelSurface,
} from "~/rightPanelStore";
import { useJiraCapabilities, useJiraEnvironmentId } from "~/state/jira";
import { primaryServerKeybindingsAtom } from "~/state/server";

import { PanelLayoutControls, RightPanelMaximizeControl } from "../chat/PanelLayoutControls";
import { JiraIcon } from "../Icons";
import { PullRequestListGhost } from "../pullRequest/PullRequestGhosts";
import { RightPanelTabs } from "../RightPanelTabs";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { JiraIssueDetailPanel } from "./JiraIssueDetailPanel";
import { JiraConfigurationSteps } from "./jiraPresentation";

const EMPTY_PENDING_SURFACES = new Set<string>();
const EMPTY_PREVIEW_SESSIONS = {};
const EMPTY_PREVIEW_DESKTOP_STATE = {};
const EMPTY_TERMINAL_LABELS = new Map<string, string>();

export type JiraIssuesPageContext = {
  readonly environmentId: EnvironmentId;
  readonly capabilities: JiraCapabilities;
  /** The surface id of the issue open in the panel, for highlighting its row. */
  readonly selectedIssueId: string | null;
  readonly onSelectIssue: (issue: JiraIssueSummary) => void;
};

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

export function JiraIssuesPageShell({
  title,
  loadingCaption,
  children,
}: {
  title: string;
  loadingCaption: string;
  children: (context: JiraIssuesPageContext) => ReactNode;
}) {
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
  const presenceValue = {
    activeSurface: selectedIssueSurface,
    surfaces: rightPanelState.surfaces,
  };
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

  const selectIssue = (issue: JiraIssueSummary) =>
    useRightPanelStore.getState().openJiraIssue(JIRA_ISSUES_PANEL_REF, issue);

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
            <WorkspaceBreadcrumb ariaLabel={`${title} breadcrumb`}>
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">{title}</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </WorkspacePageHeader>
          <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
            <WorkspacePageContainer width="expanded" className="min-h-full gap-4">
              {capabilities === null || environmentId === null ? (
                <PullRequestListGhost rows={7} caption={loadingCaption} />
              ) : !capabilities.configured ? (
                <JiraNotConfiguredState />
              ) : (
                <Fragment key={environmentId}>
                  {children({
                    environmentId,
                    capabilities,
                    selectedIssueId: activeIssueSurface?.id ?? null,
                    onSelectIssue: selectIssue,
                  })}
                </Fragment>
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
