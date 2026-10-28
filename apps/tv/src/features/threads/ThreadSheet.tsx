import { useEffect, useEffectEvent } from "react";
import { BackHandler, ScrollView, StyleSheet, Text, TVFocusGuideView, View } from "react-native";

import { FocusablePressable } from "../../components/FocusablePressable";
import { colors, typography } from "../../components/theme";

export interface ThreadSheetRow {
  readonly key: string;
  readonly label: string;
  readonly subtitle?: string | null;
  /** Dimmed and skipped by focus: a status line, or an action that cannot run now. */
  readonly disabled?: boolean;
  readonly tone?: "default" | "danger" | "accent";
  /** A status dot before the label. */
  readonly dotColor?: string;
  /** Without one the row is still a focus stop, so a long read-only list scrolls. */
  readonly onPress?: () => void;
}

/**
 * A focusable list over the right of the conversation. Focus stays inside while it is open, and
 * Menu calls `onClose` before the app's own Menu handler sees it.
 */
export function ThreadSheet(props: {
  readonly title: string;
  readonly subtitle?: string | null;
  readonly notice?: { readonly text: string; readonly tone: "muted" | "danger" } | null;
  readonly rows: ReadonlyArray<ThreadSheetRow>;
  readonly onClose: () => void;
}) {
  const onClose = useEffectEvent(() => props.onClose());
  // The app holds the tvOS Menu key whenever focus is in the conversation, and the sheet keeps
  // focus there, so it only needs to see Menu first: BackHandler calls the newest handler first.
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, []);

  const firstFocusable = props.rows.find((row) => !row.disabled)?.key;
  return (
    <View style={styles.overlay}>
      <View style={styles.scrim} />
      <TVFocusGuideView
        style={styles.sheet}
        autoFocus
        trapFocusUp
        trapFocusDown
        trapFocusLeft
        trapFocusRight
      >
        <Text style={styles.title} numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text style={styles.subtitle} numberOfLines={2}>
            {props.subtitle}
          </Text>
        ) : null}
        {props.notice ? (
          <Text
            style={[styles.notice, props.notice.tone === "danger" && { color: colors.danger }]}
            numberOfLines={4}
          >
            {props.notice.text}
          </Text>
        ) : null}
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {props.rows.map((row) => (
            <SheetRow key={row.key} row={row} preferred={row.key === firstFocusable} />
          ))}
        </ScrollView>
        <Text style={styles.hint}>Menu closes</Text>
      </TVFocusGuideView>
    </View>
  );
}

function SheetRow(props: { readonly row: ThreadSheetRow; readonly preferred: boolean }) {
  const { row } = props;
  const labelColor =
    row.tone === "danger" ? colors.danger : row.tone === "accent" ? colors.accent : colors.text;
  const content = (
    <View style={styles.rowContent}>
      {row.dotColor ? <View style={[styles.dot, { backgroundColor: row.dotColor }]} /> : null}
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, { color: labelColor }]} numberOfLines={1}>
          {row.label}
        </Text>
        {row.subtitle ? (
          <Text style={styles.rowSubtitle} numberOfLines={2}>
            {row.subtitle}
          </Text>
        ) : null}
      </View>
    </View>
  );
  if (row.disabled) return <View style={[styles.row, styles.disabledRow]}>{content}</View>;
  return (
    <FocusablePressable
      style={styles.row}
      hasTVPreferredFocus={props.preferred}
      {...(row.onPress ? { onPress: row.onPress } : {})}
    >
      {content}
    </FocusablePressable>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, flexDirection: "row" },
  scrim: { flex: 1, backgroundColor: "rgba(0, 0, 0, 0.55)" },
  sheet: {
    width: 720,
    backgroundColor: colors.surface,
    paddingTop: 56,
    paddingBottom: 32,
    paddingHorizontal: 32,
    gap: 12,
  },
  title: { color: colors.text, ...typography.heading2, fontWeight: "700" },
  subtitle: { color: colors.textMuted, ...typography.small },
  notice: { color: colors.textMuted, ...typography.small },
  list: { flex: 1 },
  listContent: { gap: 10, paddingVertical: 12 },
  row: { paddingHorizontal: 24, paddingVertical: 16, borderRadius: 16 },
  disabledRow: { opacity: 0.6, borderWidth: 3, borderColor: "transparent" },
  rowContent: { flexDirection: "row", alignItems: "center", gap: 16 },
  rowText: { flex: 1, gap: 4 },
  rowLabel: { ...typography.body, fontWeight: "600" },
  rowSubtitle: { color: colors.textMuted, ...typography.small },
  dot: { width: 14, height: 14, borderRadius: 7 },
  hint: { color: colors.textMuted, ...typography.small, textAlign: "right" },
});
