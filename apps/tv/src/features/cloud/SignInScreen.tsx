import { isClerkAPIResponseError, useSignIn } from "@clerk/expo";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { TvTextInput } from "../../components/TvTextInput";

type Step = "email" | "code";

function describeClerkError(error: unknown): string {
  if (isClerkAPIResponseError(error)) {
    const first = error.errors[0];
    return first?.longMessage ?? first?.message ?? error.message;
  }
  if (error && typeof error === "object" && "longMessage" in error) {
    const longMessage = (error as { longMessage?: unknown }).longMessage;
    if (typeof longMessage === "string" && longMessage) return longMessage;
  }
  return error instanceof Error ? error.message : "Sign-in failed.";
}

/**
 * Email code sign-in for T3 Connect. tvOS has no browser or web view, so Clerk's
 * OAuth strategies cannot run; the account must already exist (sign up on the
 * phone or web first). Render inside CloudAuthProvider.
 */
export function SignInScreen(props: { readonly onSignedIn?: () => void }) {
  const { signIn, fetchStatus } = useSignIn();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = fetchStatus === "fetching";

  const sendCode = async () => {
    if (!signIn || !email.trim()) return;
    setError(null);
    try {
      const result = await signIn.emailCode.sendCode({ emailAddress: email.trim() });
      if (result.error) {
        setError(describeClerkError(result.error));
        return;
      }
      setStep("code");
    } catch (cause) {
      setError(describeClerkError(cause));
    }
  };

  const verifyCode = async () => {
    if (!signIn || !code.trim()) return;
    setError(null);
    try {
      const verified = await signIn.emailCode.verifyCode({ code: code.trim() });
      if (verified.error) {
        setError(describeClerkError(verified.error));
        return;
      }
      if (signIn.status !== "complete") {
        setError(`Sign-in needs another step (${signIn.status}), which the TV does not support.`);
        return;
      }
      const finalized = await signIn.finalize();
      if (finalized.error) {
        setError(describeClerkError(finalized.error));
        return;
      }
      props.onSignedIn?.();
    } catch (cause) {
      setError(describeClerkError(cause));
    }
  };

  const startOver = async () => {
    setError(null);
    setCode("");
    setStep("email");
    await signIn?.reset();
  };

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Sign in to T3 Connect</Text>
      {step === "email" ? (
        <>
          <TvTextInput
            label="Email address"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            returnKeyType="done"
          />
          <FocusableButton
            label="Send code"
            disabled={busy || !email.trim()}
            onPress={() => void sendCode()}
            hasTVPreferredFocus
          />
        </>
      ) : (
        <>
          <TvTextInput
            label={`Enter the code sent to ${email.trim()}`}
            value={code}
            onChangeText={setCode}
            placeholder="123456"
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            returnKeyType="done"
          />
          <View style={styles.row}>
            <FocusableButton
              label="Verify"
              disabled={busy || !code.trim()}
              onPress={() => void verifyCode()}
              hasTVPreferredFocus
            />
            <FocusableButton label="Use another email" onPress={() => void startOver()} />
          </View>
        </>
      )}
      {busy ? <ActivityIndicator style={styles.spinner} color="white" size="large" /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function FocusableButton(
  props: Omit<PressableProps, "style" | "children"> & { readonly label: string },
) {
  const { label, ...rest } = props;
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      {...rest}
      onFocus={(event) => {
        setFocused(true);
        rest.onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        rest.onBlur?.(event);
      }}
      style={[
        styles.button,
        focused && styles.buttonFocused,
        rest.disabled ? styles.buttonDisabled : null,
      ]}
    >
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: "center",
    gap: 32,
    paddingHorizontal: 240,
    backgroundColor: "#0b0b0f",
  },
  title: { color: "white", fontSize: 64, fontWeight: "700", marginBottom: 16 },
  row: { flexDirection: "row", gap: 32 },
  button: {
    alignSelf: "flex-start",
    paddingHorizontal: 48,
    paddingVertical: 24,
    borderRadius: 16,
    backgroundColor: "#2a2a33",
  },
  buttonFocused: { backgroundColor: "#5b5bf0", transform: [{ scale: 1.08 }] },
  buttonDisabled: { opacity: 0.5 },
  buttonLabel: { color: "white", fontSize: 32, fontWeight: "600" },
  spinner: { alignSelf: "flex-start" },
  error: { color: "#ff7b7b", fontSize: 30 },
});
