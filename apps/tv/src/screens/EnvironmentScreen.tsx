import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { StyleSheet, Text, View } from "react-native";

import { ConnectionBadge } from "../components/ConnectionBadge";
import { FocusablePressable } from "../components/FocusablePressable";
import { colors } from "../components/theme";
import { ThreadSectionList } from "../features/home/ThreadSectionList";
import type { ThreadRef } from "../navigation/stack";
import { environmentShell, environmentSummaries } from "../state/environments";

export function EnvironmentScreen(props: {
  readonly hidden: boolean;
  readonly environmentId: EnvironmentId;
  readonly onBack: () => void;
  readonly onOpenThread: (thread: ThreadRef, siblings: ReadonlyArray<ThreadRef>) => void;
}) {
  const environments = useAtomValue(environmentSummaries.environmentsAtom);
  const environment = environments.find((entry) => entry.environmentId === props.environmentId);
  // Reading the shell state subscribes to the environment's shell stream while this screen shows.
  const shell = useAtomValue(environmentShell.stateValueAtom(props.environmentId));
  const shellError = Option.getOrNull(shell.error);

  return (
    // Hidden, not unmounted, under an open thread so filters and scroll survive Menu.
    <View style={[styles.root, props.hidden && styles.hidden]}>
      <View style={styles.header}>
        <FocusablePressable style={styles.backButton} onPress={props.onBack}>
          <Text style={styles.buttonLabel}>‹ Back</Text>
        </FocusablePressable>
        <View style={styles.headerText}>
          <Text style={styles.title}>{environment?.environmentLabel ?? "Environment"}</Text>
          {environment ? <ConnectionBadge phase={environment.connectionState} /> : null}
        </View>
        <Text style={styles.muted}>
          {shell.status === "synchronizing" ? "Syncing…" : ""}
          {shellError ? ` ${shellError}` : ""}
        </Text>
      </View>
      <ThreadSectionList environmentId={props.environmentId} onOpenThread={props.onOpenThread} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 96, paddingTop: 56 },
  hidden: { display: "none" },
  header: { flexDirection: "row", alignItems: "center", gap: 40, marginBottom: 28 },
  headerText: { gap: 8 },
  backButton: { paddingHorizontal: 28, paddingVertical: 16 },
  title: { color: colors.text, fontSize: 52, fontWeight: "700" },
  buttonLabel: { color: colors.text, fontSize: 28, fontWeight: "600" },
  muted: { color: colors.textMuted, fontSize: 24, flexShrink: 1 },
});
