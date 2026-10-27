import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { FocusablePressable } from "../../components/FocusablePressable";
import { colors } from "../../components/theme";
import { isCloudAuthConfigured } from "./CloudAuthProvider";
import { useCloudAccount } from "./readClerkToken";

/** The connections screen's T3 Connect card: a sign-in entry, or the account and sign-out. */
export function CloudAccountCard(props: { readonly onSignIn: () => void }) {
  if (!isCloudAuthConfigured) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>T3 Connect</Text>
        <Text style={styles.muted}>
          This build has no T3 Connect configuration. Copy .env.example to .env at the repository
          root and rebuild.
        </Text>
      </View>
    );
  }
  return <ConfiguredCloudAccountCard onSignIn={props.onSignIn} />;
}

function ConfiguredCloudAccountCard(props: { readonly onSignIn: () => void }) {
  const account = useCloudAccount();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!account.isLoaded) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>T3 Connect</Text>
        <Text style={styles.muted}>Loading account…</Text>
      </View>
    );
  }

  if (!account.isSignedIn) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>T3 Connect</Text>
        <Text style={styles.muted}>
          Sign in with an email code to reach your environments through the relay.
        </Text>
        <FocusablePressable
          style={styles.button}
          focusedStyle={styles.buttonFocused}
          onPress={props.onSignIn}
        >
          <Text style={styles.buttonLabel}>Sign in to T3 Connect</Text>
        </FocusablePressable>
      </View>
    );
  }

  const signOut = async () => {
    setError(null);
    setSigningOut(true);
    try {
      await account.signOut();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-out failed.");
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>T3 Connect</Text>
      <Text style={styles.muted}>Signed in as</Text>
      <Text style={styles.account} numberOfLines={1}>
        {account.emailAddress ?? account.userId}
      </Text>
      <FocusablePressable
        style={styles.button}
        focusedStyle={styles.buttonFocused}
        disabled={signingOut}
        onPress={() => void signOut()}
      >
        <Text style={styles.buttonLabel}>{signingOut ? "Signing out…" : "Sign out"}</Text>
      </FocusablePressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: 24, padding: 40, gap: 16 },
  title: { color: colors.text, fontSize: 38, fontWeight: "600", marginBottom: 8 },
  account: { color: colors.text, fontSize: 32, fontWeight: "600" },
  muted: { color: colors.textMuted, fontSize: 26 },
  error: { color: colors.danger, fontSize: 26 },
  button: {
    marginTop: 16,
    alignItems: "center",
    paddingVertical: 22,
    backgroundColor: colors.surfaceFocused,
  },
  buttonFocused: { backgroundColor: colors.accent },
  buttonLabel: { color: colors.text, fontSize: 30, fontWeight: "600" },
});
