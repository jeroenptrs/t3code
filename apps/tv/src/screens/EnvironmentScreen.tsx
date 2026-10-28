import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { ConnectionBadge } from "../components/ConnectionBadge";
import { FocusablePressable } from "../components/FocusablePressable";
import { colors } from "../components/theme";
import { ThreadSectionList } from "../features/home/ThreadSectionList";
import { environmentShell, environmentSummaries } from "../state/environments";
import { ThreadScreen } from "./ThreadScreen";

export function EnvironmentScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly onBack: () => void;
}) {
  const environments = useAtomValue(environmentSummaries.environmentsAtom);
  const environment = environments.find((entry) => entry.environmentId === props.environmentId);
  // Reading the shell state subscribes to the environment's shell stream while this screen shows.
  const shell = useAtomValue(environmentShell.stateValueAtom(props.environmentId));
  const shellError = Option.getOrNull(shell.error);

  const [openThreadId, setOpenThreadId] = useState<ThreadId | null>(null);
  const openThread = useCallback(
    (thread: EnvironmentThreadShell) => setOpenThreadId(thread.id),
    [],
  );
  const closeThread = useCallback(() => setOpenThreadId(null), []);

  return (
    <>
      {openThreadId !== null ? (
        <ThreadScreen
          environmentId={props.environmentId}
          threadId={openThreadId}
          onBack={closeThread}
        />
      ) : null}
      {/* Hidden, not unmounted, under an open thread so filters and scroll survive Menu. */}
      <View style={[styles.root, openThreadId !== null && styles.hidden]}>
        <View style={styles.header}>
          <FocusablePressable style={styles.backButton} onPress={props.onBack}>
            <Text style={styles.buttonLabel}>‹ Home</Text>
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
        <ThreadSectionList environmentId={props.environmentId} onOpenThread={openThread} />
      </View>
    </>
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
