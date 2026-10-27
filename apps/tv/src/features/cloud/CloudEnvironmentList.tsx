import { useAtomValue } from "@effect/atom-react";
import type { Discovery } from "@t3tools/client-runtime/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { FocusablePressable } from "../../components/FocusablePressable";
import { colors } from "../../components/theme";
import { environmentCatalog } from "../../state/environments";
import {
  refreshRelayEnvironments,
  registerRelayEnvironment,
  relayEnvironmentDiscovery,
} from "../../state/relay";
import { isCloudAuthConfigured } from "./CloudAuthProvider";
import { useCloudAccount } from "./readClerkToken";

type RelayDiscoveredEnvironment = Discovery.RelayDiscoveredEnvironment;

/**
 * The signed-in account's T3 Connect environments that this TV has not saved yet. Selecting
 * one saves it as a relay connection and opens it; saved ones show in the environment list.
 */
export function CloudEnvironmentList(props: {
  readonly onOpenEnvironment: (environmentId: EnvironmentId) => void;
}) {
  if (!isCloudAuthConfigured) return null;
  return <SignedInCloudEnvironmentList {...props} />;
}

function SignedInCloudEnvironmentList(props: {
  readonly onOpenEnvironment: (environmentId: EnvironmentId) => void;
}) {
  const account = useCloudAccount();
  if (!account.isLoaded) return null;
  if (!account.isSignedIn || account.userId === null) {
    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>T3 Connect</Text>
        <Text style={styles.muted}>Sign in to T3 Connect to see your environments here.</Text>
      </View>
    );
  }
  return <DiscoveredEnvironments key={account.userId} {...props} />;
}

function DiscoveredEnvironments(props: {
  readonly onOpenEnvironment: (environmentId: EnvironmentId) => void;
}) {
  const discovery = useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refreshRelayEnvironments();
  }, []);

  const available = [...discovery.environments.values()].filter(
    (entry) => !catalog.entries.has(entry.environment.environmentId),
  );
  const discoveryError = Option.getOrNull(discovery.error)?.message ?? null;

  const select = async (entry: RelayDiscoveredEnvironment) => {
    const environmentId = entry.environment.environmentId;
    setError(null);
    setPendingId(environmentId);
    const failure = await registerRelayEnvironment(entry.environment);
    setPendingId(null);
    if (failure !== null) {
      setError(failure);
      return;
    }
    props.onOpenEnvironment(environmentId);
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>T3 Connect</Text>
      {available.map((entry) => (
        <FocusablePressable
          key={entry.environment.environmentId}
          style={styles.row}
          disabled={pendingId !== null}
          onPress={() => void select(entry)}
        >
          <Text style={styles.label}>{entry.environment.label}</Text>
          <AvailabilityBadge entry={entry} adding={pendingId === entry.environment.environmentId} />
        </FocusablePressable>
      ))}
      {available.length === 0 ? (
        <Text style={styles.muted}>
          {discovery.refreshing
            ? "Loading your T3 Connect environments…"
            : discovery.offline
              ? "Offline. Your T3 Connect environments load once the network is back."
              : discoveryError
                ? `Could not load T3 Connect environments: ${discoveryError}`
                : discovery.environments.size > 0
                  ? "All your T3 Connect environments are saved on this TV."
                  : "No T3 Connect environments on this account."}
        </Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <FocusablePressable
        style={styles.smallButton}
        disabled={discovery.refreshing}
        onPress={refreshRelayEnvironments}
      >
        <Text style={styles.buttonLabel}>{discovery.refreshing ? "Refreshing…" : "Refresh"}</Text>
      </FocusablePressable>
    </View>
  );
}

const AVAILABILITY: Record<
  RelayDiscoveredEnvironment["availability"],
  { label: string; tone: string }
> = {
  checking: { label: "Checking", tone: colors.warning },
  online: { label: "Online", tone: colors.success },
  offline: { label: "Offline", tone: colors.textMuted },
  error: { label: "Error", tone: colors.danger },
};

function AvailabilityBadge(props: {
  readonly entry: RelayDiscoveredEnvironment;
  readonly adding: boolean;
}) {
  const { label, tone } = AVAILABILITY[props.entry.availability];
  const detail = Option.getOrNull(props.entry.error)?.message ?? null;
  return (
    <>
      <View style={styles.badge}>
        <View style={[styles.dot, { backgroundColor: tone }]} />
        <Text style={styles.muted}>{props.adding ? "Adding…" : label}</Text>
      </View>
      {detail ? (
        <Text style={styles.error} numberOfLines={2}>
          {detail}
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  section: { gap: 20, marginTop: 32 },
  sectionTitle: { color: colors.text, fontSize: 38, fontWeight: "600", marginBottom: 8 },
  row: { padding: 28, gap: 10 },
  label: { color: colors.text, fontSize: 36, fontWeight: "600" },
  badge: { flexDirection: "row", alignItems: "center", gap: 12 },
  dot: { width: 16, height: 16, borderRadius: 8 },
  muted: { color: colors.textMuted, fontSize: 26 },
  error: { color: colors.danger, fontSize: 26 },
  smallButton: { alignSelf: "flex-start", paddingVertical: 16, paddingHorizontal: 32 },
  buttonLabel: { color: colors.text, fontSize: 28, fontWeight: "600" },
});
