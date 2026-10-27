import { useState } from "react";
import { StyleSheet, Text, TextInput, TVFocusGuideView, View } from "react-native";

import { FocusablePressable } from "../../components/FocusablePressable";
import { colors, typography } from "../../components/theme";

/**
 * The reply box. On tvOS, selecting the input opens the system keyboard, which takes Siri
 * Remote dictation and the iPhone's Continuity keyboard; Send submits and clears.
 */
export function ThreadReplyBox(props: {
  readonly sendLabel: string;
  readonly hint: string | null;
  readonly error: string | null;
  readonly disabled: boolean;
  readonly onSend: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const [sending, setSending] = useState(false);
  const canSend = !props.disabled && !sending && text.trim().length > 0;

  const send = async () => {
    if (!canSend) return;
    const sentText = text.trim();
    setSending(true);
    // Clear at once as mobile does, and restore the text if the server refuses it.
    setText("");
    const sent = await props.onSend(sentText);
    setSending(false);
    if (!sent) setText((current) => (current.length === 0 ? sentText : current));
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
            editable={!props.disabled}
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
