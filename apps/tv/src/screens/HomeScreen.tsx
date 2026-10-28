import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnectionSummary } from "@t3tools/client-runtime/state/presentation";
import type { EnvironmentId } from "@t3tools/contracts";
import { StyleSheet, Text, TVFocusGuideView, View } from "react-native";

import { FocusablePressable } from "../components/FocusablePressable";
import { colors } from "../components/theme";
import { ThreadSectionList } from "../features/home/ThreadSectionList";
import type { ThreadRef } from "../navigation/stack";
import { environmentSummaries } from "../state/environments";

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

export function HomeScreen(props: {
  readonly hidden: boolean;
  readonly onOpenConnections: () => void;
  readonly onOpenEnvironment: (environmentId: EnvironmentId) => void;
  readonly onOpenThread: (thread: ThreadRef, siblings: ReadonlyArray<ThreadRef>) => void;
}) {
  const environments = useAtomValue(environmentSummaries.environmentsAtom);
  const allConnected = environments.every((entry) => entry.connectionState === "connected");

  return (
    // Hidden, not unmounted, under an open thread so filters and scroll survive Menu.
    <View style={[styles.root, props.hidden && styles.hidden]}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Threads</Text>
          <Text style={[styles.status, !allConnected && styles.statusWarning]}>
            {connectionSummaryLabel(environments)}
          </Text>
        </View>
        {/* Connections leads, so moving up into the header always lands on the way out. */}
        <TVFocusGuideView style={styles.actions} autoFocus>
          <FocusablePressable style={styles.action} onPress={props.onOpenConnections}>
            <Text style={styles.actionLabel}>Connections</Text>
          </FocusablePressable>
          {environments.map((environment) => (
            <FocusablePressable
              key={environment.environmentId}
              style={styles.action}
              onPress={() => props.onOpenEnvironment(environment.environmentId)}
            >
              <Text style={styles.actionLabel} numberOfLines={1}>
                {environment.environmentLabel}
              </Text>
            </FocusablePressable>
          ))}
        </TVFocusGuideView>
      </View>
      <ThreadSectionList environmentId={null} onOpenThread={props.onOpenThread} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 96, paddingTop: 56 },
  hidden: { display: "none" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 40,
    marginBottom: 28,
  },
  headerText: { gap: 6, flexShrink: 1 },
  title: { color: colors.text, fontSize: 52, fontWeight: "700" },
  status: { color: colors.textMuted, fontSize: 26 },
  statusWarning: { color: colors.warning },
  actions: { flexDirection: "row", gap: 16 },
  action: { paddingHorizontal: 24, paddingVertical: 14, maxWidth: 420 },
  actionLabel: { color: colors.text, fontSize: 26, fontWeight: "600" },
});
