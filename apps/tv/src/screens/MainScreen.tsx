import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnectionSummary } from "@t3tools/client-runtime/state/presentation";
import type { EnvironmentId } from "@t3tools/contracts";
import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { StyleSheet, Text, TVFocusGuideView, View } from "react-native";

import { FocusablePressable, type FocusableHost } from "../components/FocusablePressable";
import { colors, typeScale } from "../components/theme";
import {
  ThreadSectionList,
  type ThreadSectionListHandle,
} from "../features/home/ThreadSectionList";
import { ThreadActionsSheet } from "../features/threads/ThreadActionsSheet";
import type { ThreadRef } from "../navigation/stack";
import { environmentSummaries } from "../state/environments";
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

export interface MainScreenHandle {
  /** Moves focus to the selected sidebar row, or the filters when it is not listed. */
  readonly focusSidebar: () => void;
}

/**
 * The sidebar of threads beside the selected conversation. Left from the conversation lands on
 * the selected row; selecting a thread, or Right into the conversation, lands on its newest
 * message (ThreadScreen's own guide).
 */
export function MainScreen({
  ref,
  ...props
}: {
  readonly ref?: Ref<MainScreenHandle>;
  readonly hidden: boolean;
  readonly environmentFilter: EnvironmentId | null;
  readonly onEnvironmentFilterChange: (environmentId: EnvironmentId | null) => void;
  readonly onOpenConnections: () => void;
  /** Whether focus is in the conversation, where Menu returns to the sidebar. */
  readonly onConversationFocusChange: (focused: boolean) => void;
}) {
  const environments = useAtomValue(environmentSummaries.environmentsAtom);
  const allConnected = environments.every((entry) => entry.connectionState === "connected");
  const [selectedThread, setSelectedThread] = useState<ThreadRef | null>(null);
  // Bumped per selection: the conversation moves focus to its newest message once per value.
  const [focusRequest, setFocusRequest] = useState(0);
  const selectThread = (thread: ThreadRef) => {
    setSelectedThread(thread);
    setFocusRequest((request) => request + 1);
  };
  const [actionsThread, setActionsThread] = useState<ThreadRef | null>(null);
  const sectionList = useRef<ThreadSectionListHandle>(null);
  // State, not a ref: the sidebar guide re-renders with the row as its destination.
  const [selectedRow, setSelectedRow] = useState<FocusableHost | null>(null);
  const [filter, setFilter] = useState<FocusableHost | null>(null);

  const focusSidebar = () => (selectedRow ?? filter)?.requestTVFocus?.();
  useImperativeHandle(ref, () => ({ focusSidebar }));
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
          onSelectedRowHost={setSelectedRow}
          filterRef={setFilter}
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
      <TVFocusGuideView
        style={styles.conversation}
        onFocusEnter={() => props.onConversationFocusChange(true)}
        onFocusLeave={() => props.onConversationFocusChange(false)}
      >
        {selectedThread ? (
          <ThreadScreen
            key={`${selectedThread.environmentId}:${selectedThread.threadId}`}
            thread={selectedThread}
            hidden={props.hidden || actionsThread !== null}
            focusRequest={focusRequest}
            onBack={focusSidebar}
            onOpenThread={selectThread}
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
