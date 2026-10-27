import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { StyleSheet, Text, View } from "react-native";

import { colors } from "./theme";

const LABELS: Record<EnvironmentConnectionPhase, string> = {
  available: "Available",
  offline: "Offline",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  connected: "Connected",
  error: "Error",
  unsupported: "Unsupported",
};

function tone(phase: EnvironmentConnectionPhase): string {
  switch (phase) {
    case "connected":
      return colors.success;
    case "connecting":
    case "reconnecting":
      return colors.warning;
    case "error":
    case "unsupported":
      return colors.danger;
    default:
      return colors.textMuted;
  }
}

export function ConnectionBadge(props: { readonly phase: EnvironmentConnectionPhase }) {
  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: tone(props.phase) }]} />
      <Text style={styles.label}>{LABELS[props.phase]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  dot: { width: 16, height: 16, borderRadius: 8 },
  label: { color: colors.textMuted, fontSize: 26 },
});
