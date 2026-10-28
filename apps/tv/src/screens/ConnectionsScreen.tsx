import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnectionSummary } from "@t3tools/client-runtime/state/presentation";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { ScrollView, StyleSheet, Text, TVFocusGuideView, View } from "react-native";

import { ConnectionBadge } from "../components/ConnectionBadge";
import { FocusablePressable } from "../components/FocusablePressable";
import { colors } from "../components/theme";
import { TvTextInput } from "../components/TvTextInput";
import { CloudAccountCard } from "../features/cloud/CloudAccountCard";
import { CloudEnvironmentList } from "../features/cloud/CloudEnvironmentList";
import { tvAtomRegistry } from "../state/atom-registry";
import { environmentCatalog, environmentSummaries } from "../state/environments";
import { pairingFormAtom, submitPairingForm, updatePairingForm } from "../state/pairing-form";

export function ConnectionsScreen(props: {
  readonly onOpenEnvironment: (environmentId: EnvironmentId) => void;
  readonly onSignIn: () => void;
}) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const environments = useAtomValue(environmentSummaries.environmentsAtom);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.title}>T3 Code</Text>
      <View style={styles.columns}>
        <View style={styles.formColumn}>
          <PairingForm hasEnvironments={environments.length > 0} />
          <CloudAccountCard onSignIn={props.onSignIn} />
        </View>
        <TVFocusGuideView style={styles.listColumn} autoFocus>
          <Text style={styles.sectionTitle}>Environments</Text>
          {!catalog.isReady ? (
            <Text style={styles.muted}>Loading saved environments…</Text>
          ) : environments.length === 0 ? (
            <Text style={styles.muted}>
              No environments yet. Pair one with its host and code, or add one from T3 Connect.
            </Text>
          ) : (
            environments.map((environment, index) => (
              <EnvironmentRow
                key={environment.environmentId}
                environment={environment}
                preferredFocus={index === 0}
                onOpen={() => props.onOpenEnvironment(environment.environmentId)}
              />
            ))
          )}
          <CloudEnvironmentList onOpenEnvironment={props.onOpenEnvironment} />
        </TVFocusGuideView>
      </View>
    </ScrollView>
  );
}

function PairingForm(props: { readonly hasEnvironments: boolean }) {
  const { host, code, pending, error } = useAtomValue(pairingFormAtom);

  return (
    <TVFocusGuideView style={styles.card} autoFocus>
      <Text style={styles.sectionTitle}>Pair with host and code</Text>
      <Text style={styles.muted}>
        Run `t3 pair` on the host, or open Settings → Connections in T3 Code, and enter the host and
        pairing code it shows.
      </Text>
      <TvTextInput
        label="Host"
        value={host}
        onChangeText={(value) => updatePairingForm({ host: value })}
        placeholder="192.168.1.20:3773"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        hasTVPreferredFocus={!props.hasEnvironments}
      />
      <TvTextInput
        label="Pairing code"
        value={code}
        onChangeText={(value) => updatePairingForm({ code: value })}
        placeholder="Pairing code"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <FocusablePressable
        style={styles.button}
        focusedStyle={styles.buttonFocused}
        disabled={pending}
        onPress={() => void submitPairingForm()}
      >
        <Text style={styles.buttonLabel}>{pending ? "Connecting…" : "Connect"}</Text>
      </FocusablePressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </TVFocusGuideView>
  );
}

function EnvironmentRow(props: {
  readonly environment: EnvironmentConnectionSummary;
  readonly preferredFocus: boolean;
  readonly onOpen: () => void;
}) {
  const { environment } = props;
  return (
    <View style={styles.environmentRow}>
      <FocusablePressable
        style={styles.environmentMain}
        hasTVPreferredFocus={props.preferredFocus}
        onPress={props.onOpen}
      >
        <Text style={styles.environmentLabel}>{environment.environmentLabel}</Text>
        {environment.displayUrl ? <Text style={styles.muted}>{environment.displayUrl}</Text> : null}
        <ConnectionBadge phase={environment.connectionState} />
        {environment.connectionError ? (
          <Text style={styles.error} numberOfLines={2}>
            {environment.connectionError}
          </Text>
        ) : null}
      </FocusablePressable>
      <FocusablePressable
        style={styles.smallButton}
        onPress={() =>
          void runAtomCommand(
            tvAtomRegistry,
            environmentCatalog.retryNow,
            environment.environmentId,
          )
        }
      >
        <Text style={styles.buttonLabel}>Retry</Text>
      </FocusablePressable>
      <FocusablePressable
        style={styles.smallButton}
        onPress={() =>
          void runAtomCommand(tvAtomRegistry, environmentCatalog.remove, environment.environmentId)
        }
      >
        <Text style={styles.buttonLabel}>Remove</Text>
      </FocusablePressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 96, paddingVertical: 64 },
  title: { color: colors.text, fontSize: 64, fontWeight: "700", marginBottom: 40 },
  columns: { flexDirection: "row", gap: 64 },
  formColumn: { width: 720, gap: 32 },
  listColumn: { flex: 1, gap: 20 },
  card: { backgroundColor: colors.surface, borderRadius: 24, padding: 40, gap: 16 },
  sectionTitle: { color: colors.text, fontSize: 38, fontWeight: "600", marginBottom: 8 },
  button: {
    marginTop: 24,
    alignItems: "center",
    paddingVertical: 22,
    backgroundColor: colors.surfaceFocused,
  },
  buttonFocused: { backgroundColor: colors.accent },
  buttonLabel: { color: colors.text, fontSize: 30, fontWeight: "600" },
  smallButton: { justifyContent: "center", paddingHorizontal: 32 },
  muted: { color: colors.textMuted, fontSize: 26 },
  error: { color: colors.danger, fontSize: 26 },
  environmentRow: { flexDirection: "row", gap: 16 },
  environmentMain: { flex: 1, padding: 28, gap: 10 },
  environmentLabel: { color: colors.text, fontSize: 36, fontWeight: "600" },
});
