import { useEffect, useRef, useState, type ComponentRef, type Ref } from "react";
import { StyleSheet, Text, View, type TextInput } from "react-native";

import { FocusablePressable } from "../../components/FocusablePressable";
import { TvTextInput } from "../../components/TvTextInput";
import { colors, conversation, typography } from "../../components/theme";

// Text whose send failed after its reply box closed, by thread, so reopening the thread restores it.
const unsentTextByThread = new Map<string, string>();

/**
 * The reply box. On tvOS, selecting the input opens the system keyboard, which takes Siri
 * Remote dictation and the iPhone's Continuity keyboard. The text stays in the input until the
 * server accepts it, and stays there with the error shown if the server refuses it.
 */
export function ThreadReplyBox({
  inputHost,
  ...props
}: {
  readonly threadKey: string;
  readonly sendLabel: string;
  readonly hint: string | null;
  readonly error: string | null;
  readonly disabled: boolean;
  readonly onSend: (text: string) => Promise<boolean>;
  /** The input's native field, so a focus guide can send focus to it. */
  readonly inputHost?: Ref<ComponentRef<typeof TextInput>>;
}) {
  const [text, setText] = useState(() => unsentTextByThread.get(props.threadKey) ?? "");
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
    if (sent) setText((current) => (current.trim() === sentText ? "" : current));
  };

  return (
    <View style={styles.root}>
      {props.error ? <Text style={styles.error}>{props.error}</Text> : null}
      {props.hint ? <Text style={styles.hint}>{props.hint}</Text> : null}
      <View style={styles.row}>
        <View style={styles.inputColumn}>
          <TvTextInput
            ref={inputHost}
            value={text}
            onChangeText={setText}
            placeholder="Reply… (select to type or dictate)"
            editable={!props.disabled}
            // Done closes the keyboard and keeps the text; tvOS returns focus to this field,
            // with Send one press right. Only Send sends.
            returnKeyType="done"
            submitBehavior="blurAndSubmit"
          />
        </View>
        <FocusablePressable
          style={styles.sendButton}
          focusedStyle={styles.sendButtonFocused}
          disabled={!canSend}
          onPress={() => void send()}
        >
          <Text style={styles.sendLabel}>{sending ? "Sending…" : props.sendLabel}</Text>
        </FocusablePressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 10, paddingTop: 16, paddingBottom: 40 },
  // Static on purpose: TvTextInput's parents must not change style with focus.
  row: {
    ...conversation.composer,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    borderWidth: 2,
    borderRadius: 36,
    padding: 10,
  },
  inputColumn: { flex: 1 },
  sendButton: {
    paddingHorizontal: 40,
    paddingVertical: 18,
    borderRadius: 28,
    backgroundColor: colors.accent,
  },
  sendButtonFocused: { backgroundColor: colors.accent, borderColor: colors.text },
  sendLabel: { color: colors.text, fontSize: 30, fontWeight: "700" },
  hint: { color: colors.textMuted, ...typography.small },
  error: { color: colors.danger, ...typography.small },
});
