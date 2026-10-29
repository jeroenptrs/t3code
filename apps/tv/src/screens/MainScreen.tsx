import { useAtomMount, useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnectionSummary } from "@t3tools/client-runtime/state/presentation";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { StyleSheet, Text, TVFocusGuideView, View } from "react-native";

import { FocusablePressable, type FocusableHost } from "../components/FocusablePressable";
import { colors, typeScale } from "../components/theme";
import {
  ThreadSectionList,
  type ThreadSectionListHandle,
} from "../features/home/ThreadSectionList";
import { useDevOpenNewThread } from "../features/threads/devOpenThread";
import { NewThreadComposer, type ProjectRef } from "../features/threads/NewThreadComposer";
import { ThreadActionsSheet } from "../features/threads/ThreadActionsSheet";
import { sidebarOwnsMenu, useMenuOwner } from "../navigation/menuScope";
import type { ThreadRef } from "../navigation/stack";
import { tvAtomRegistry } from "../state/atom-registry";
import {
  environmentSessionsAtom,
  environmentSummaries,
  environmentThreadShells,
} from "../state/environments";
import { ThreadScreen } from "./ThreadScreen";

/** At 1920x1080; the conversation takes the rest. */
export const SIDEBAR_WIDTH = 520;

/** "2 of 3 connected · Reconnecting to Office", mobile's workspace status, compact. */
export function connectionSummaryLabel(
  environments: ReadonlyArray<EnvironmentConnectionSummary>,
): string {
  const connected = environments.filter((entry) => entry.connectionState === "connected").length;
  const reconnecting = environments.filter(
    (entry) => entry.connectionState === "connecting" || entry.connectionState === "reconnecting",
  );
  const parts = [
    environments.length === 1
      ? connected === 1
        ? "Connected"
        : "Not connected"
      : `${connected} of ${environments.length} connected`,
  ];
  if (reconnecting.length === 1) parts.push(`Reconnecting to ${reconnecting[0]!.environmentLabel}`);
  else if (reconnecting.length > 1) parts.push(`Reconnecting ${reconnecting.length} environments`);
  return parts.join(" · ");
}

/**
 * The sidebar of threads beside the selected conversation or the new-thread composer. Left from
 * the conversation lands on the selected row; selecting a thread, or Right into the
 * conversation, lands on its newest message (ThreadScreen's own guide). Menu from the right pane
 * returns to the sidebar, and from the sidebar returns to its top; at the top Menu exits.
 */
export function MainScreen(props: {
  readonly hidden: boolean;
  readonly environmentFilter: EnvironmentId | null;
  readonly onEnvironmentFilterChange: (environmentId: EnvironmentId | null) => void;
  readonly onOpenConnections: () => void;
}) {
  const environments = useAtomValue(environmentSummaries.environmentsAtom);
  useAtomMount(environmentSessionsAtom);
  const allConnected = environments.every((entry) => entry.connectionState === "connected");
  const [selectedThread, setSelectedThread] = useState<ThreadRef | null>(null);
  // Bumped per selection: the conversation moves focus to its newest message once per value.
  // 0 asks for no move, for a selection made while focus stays in the sidebar.
  const [focusRequest, setFocusRequest] = useState(0);
  const [actionsThread, setActionsThread] = useState<ThreadRef | null>(null);
  // Which pane focus is in, from focus entering each side.
  const [pane, setPane] = useState<"sidebar" | "conversation">("sidebar");
  const [sidebarAtTop, setSidebarAtTop] = useState(false);
  // Bumped per open, so each one starts a fresh composer.
  const [newThread, setNewThread] = useState<{
    readonly request: number;
    readonly defaultProject: ProjectRef | null;
  } | null>(null);
  const selectThread = (thread: ThreadRef) => {
    setSelectedThread(thread);
    setNewThread(null);
    setFocusRequest((request) => request + 1);
    setPane("conversation");
  };
  const replaceSelection = (thread: ThreadRef | null) => {
    setSelectedThread(thread);
    setFocusRequest(0);
    setPane("sidebar");
  };
  const openNewThread = (project: ProjectRef | null) => {
    const shell = selectedThread
      ? tvAtomRegistry.get(environmentThreadShells.threadShellAtom(selectedThread))
      : null;
    setNewThread((current) => ({
      request: (current?.request ?? 0) + 1,
      defaultProject:
        project ??
        (shell ? { environmentId: shell.environmentId, projectId: shell.projectId } : null),
    }));
    setActionsThread(null);
    setPane("conversation");
  };
  useDevOpenNewThread(() => openNewThread(null));
  const sectionList = useRef<ThreadSectionListHandle>(null);
  // State, not a ref: the sidebar guide re-renders with the row as its destination.
  const [selectedRow, setSelectedRow] = useState<FocusableHost | null>(null);
  const [filter, setFilter] = useState<FocusableHost | null>(null);

  const focusSidebar = () => (selectedRow ?? filter)?.requestTVFocus?.();
  useMenuOwner(
    "conversation",
    () => {
      setPane("sidebar");
      focusSidebar();
    },
    pane === "conversation",
  );
  useMenuOwner(
    "sidebar",
    () => sectionList.current?.focusTop(),
    sidebarOwnsMenu(pane, sidebarAtTop),
  );
  const closeActions = () => {
    if (actionsThread !== null && !sectionList.current?.focusThread(actionsThread)) focusSidebar();
    setActionsThread(null);
  };

  return (
    // Hidden, not unmounted, under another route so selection, filters, and scroll survive.
    <View style={[styles.root, props.hidden && styles.hidden]}>
      <TVFocusGuideView
        style={styles.sidebar}
        autoFocus
        destinations={selectedRow ? [selectedRow] : undefined}
        onFocusEnter={() => setPane("sidebar")}
      >
        <View style={styles.sidebarHeader}>
          <Text style={styles.title}>Threads</Text>
          <Text style={[styles.status, !allConnected && styles.statusWarning]} numberOfLines={1}>
            {connectionSummaryLabel(environments)}
          </Text>
        </View>
        <ThreadSectionList
          ref={sectionList}
          environmentFilter={props.environmentFilter}
          onEnvironmentFilterChange={props.onEnvironmentFilterChange}
          selectedThread={selectedThread}
          onSelectThread={selectThread}
          onThreadActions={setActionsThread}
          onNewThread={openNewThread}
          onSelectedRowHost={setSelectedRow}
          filterRef={setFilter}
          onSelectionReplaced={replaceSelection}
          onFocusAtTopChange={setSidebarAtTop}
        />
        <FocusablePressable
          style={styles.connections}
          focusedStyle={styles.connectionsFocused}
          onPress={props.onOpenConnections}
        >
          <Text style={styles.connectionsLabel}>Connections</Text>
        </FocusablePressable>
      </TVFocusGuideView>
      {/* No autoFocus: a remembered child would win over ThreadScreen's newest-message guide. */}
      <TVFocusGuideView style={styles.conversation} onFocusEnter={() => setPane("conversation")}>
        {newThread !== null ? (
          <NewThreadComposer
            key={newThread.request}
            defaultProject={newThread.defaultProject}
            environmentFilter={props.environmentFilter}
            onStarted={selectThread}
          />
        ) : selectedThread ? (
          <ThreadScreen
            key={`${selectedThread.environmentId}:${selectedThread.threadId}`}
            thread={selectedThread}
            hidden={props.hidden || actionsThread !== null}
            focusRequest={focusRequest}
            onOpenThread={selectThread}
            onNewThread={openNewThread}
          />
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyLabel}>Select a thread</Text>
          </View>
        )}
      </TVFocusGuideView>
      {actionsThread !== null && !props.hidden ? (
        <ThreadActionsSheet
          key={`${actionsThread.environmentId}:${actionsThread.threadId}`}
          environmentId={actionsThread.environmentId}
          threadId={actionsThread.threadId}
          onClose={closeActions}
          onNewThread={openNewThread}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: "row", backgroundColor: colors.background },
  hidden: { display: "none" },
  sidebar: {
    width: SIDEBAR_WIDTH,
    borderRightWidth: 2,
    borderRightColor: colors.border,
    paddingTop: 48,
    paddingBottom: 32,
    paddingHorizontal: 20,
  },
  sidebarHeader: { gap: 4, marginBottom: 20, paddingHorizontal: 30 },
  title: { color: colors.text, ...typeScale["2xl"], fontWeight: "700" },
  status: { color: colors.textMuted, ...typeScale.xs },
  statusWarning: { color: colors.warning },
  connections: {
    backgroundColor: "transparent",
    borderRadius: 22,
    marginTop: 12,
    marginHorizontal: 8,
    paddingHorizontal: 22,
    paddingVertical: 16,
  },
  connectionsFocused: { backgroundColor: colors.rowHover },
  connectionsLabel: { color: colors.textMuted, ...typeScale.sm, fontWeight: "600" },
  conversation: { flex: 1, paddingHorizontal: 48 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyLabel: { color: colors.textMuted, ...typeScale.lg },
});
