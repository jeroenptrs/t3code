import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, TVFocusGuideView, View } from "react-native";

import { FocusablePressable } from "../../components/FocusablePressable";
import { colors, typography } from "../../components/theme";

// Text whose send failed after its reply box closed, by thread, so reopening the thread restores it.
const unsentTextByThread = new Map<string, string>();

/**
 * The reply box. On tvOS, selecting the input opens the system keyboard, which takes Siri
 * Remote dictation and the iPhone's Continuity keyboard. The text stays in the input until the
 * server accepts it, and stays there with the error shown if the server refuses it.
 */
export function ThreadReplyBox(props: {
  readonly threadKey: string;
  readonly sendLabel: string;
  readonly hint: string | null;
  readonly error: string | null;
  readonly disabled: boolean;
  readonly onSend: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState(() => unsentTextByThread.get(props.threadKey) ?? "");
  const [inputFocused, setInputFocused] = useState(false);
  const [sending, setSending] = useState(false);
  // State updates land a render late, so a second Send press in the same frame would pass a
  // `sending` check. The ref blocks it at once.
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const canSend = !props.disabled && !sending && text.trim().length > 0;

  useEffect(() => {
    mounted.current = true;
    unsentTextByThread.delete(props.threadKey);
    return () => {
      mounted.current = false;
    };
  }, [props.threadKey]);

  const send = async () => {
    if (!canSend || inFlight.current) return;
    inFlight.current = true;
    const sentText = text.trim();
    setSending(true);
    let sent = false;
    try {
      sent = await props.onSend(sentText);
    } finally {
      inFlight.current = false;
    }
    if (!mounted.current) {
      if (!sent) unsentTextByThread.set(props.threadKey, sentText);
      return;
    }
    setSending(false);
    if (sent) setText("");
  };

  return (
    <View style={styles.root}>
      {props.error ? <Text style={styles.error}>{props.error}</Text> : null}
      {props.hint ? <Text style={styles.hint}>{props.hint}</Text> : null}
      <TVFocusGuideView style={styles.row} autoFocus>
        <View style={[styles.inputFrame, inputFocused && styles.inputFrameFocused]}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Reply… (select to type or dictate)"
            placeholderTextColor={colors.textMuted}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            editable={!props.disabled && !sending}
            multiline={false}
            returnKeyType="send"
            onSubmitEditing={() => void send()}
          />
        </View>
        <FocusablePressable
          style={styles.sendButton}
          disabled={!canSend}
          onPress={() => void send()}
        >
          <Text style={styles.sendLabel}>{sending ? "Sending…" : props.sendLabel}</Text>
        </FocusablePressable>
      </TVFocusGuideView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 10, paddingTop: 16, paddingBottom: 40 },
  row: { flexDirection: "row", alignItems: "center", gap: 24 },
  inputFrame: {
    flex: 1,
    borderRadius: 16,
    borderWidth: 3,
    borderColor: colors.surfaceFocused,
    backgroundColor: colors.surface,
  },
  inputFrameFocused: {
    borderColor: colors.accent,
    backgroundColor: colors.surfaceFocused,
    transform: [{ scale: 1.01 }],
  },
  input: {
    color: colors.text,
    ...typography.body,
    paddingHorizontal: 28,
    paddingVertical: 18,
    minHeight: 84,
  },
  sendButton: { paddingHorizontal: 44, paddingVertical: 22 },
  sendLabel: { color: colors.text, fontSize: 30, fontWeight: "700" },
  hint: { color: colors.textMuted, ...typography.small },
  error: { color: colors.danger, ...typography.small },
});
