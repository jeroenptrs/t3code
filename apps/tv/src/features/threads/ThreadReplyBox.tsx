import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { FocusablePressable } from "../../components/FocusablePressable";
import { TvTextInput } from "../../components/TvTextInput";
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
      <View style={styles.row}>
        <View style={styles.inputColumn}>
          <TvTextInput
            value={text}
            onChangeText={setText}
            placeholder="Reply… (select to type or dictate)"
            editable={!props.disabled}
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
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 10, paddingTop: 16, paddingBottom: 40 },
  row: { flexDirection: "row", alignItems: "center", gap: 24 },
  inputColumn: { flex: 1 },
  sendButton: { paddingHorizontal: 44, paddingVertical: 22 },
  sendLabel: { color: colors.text, fontSize: 30, fontWeight: "700" },
  hint: { color: colors.textMuted, ...typography.small },
  error: { color: colors.danger, ...typography.small },
});
