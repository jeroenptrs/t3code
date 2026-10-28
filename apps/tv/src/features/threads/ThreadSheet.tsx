import type { ReactNode } from "react";
import { ScrollView, StyleSheet, Text, TVFocusGuideView, View } from "react-native";

import { FocusablePressable } from "../../components/FocusablePressable";
import { colors, typography } from "../../components/theme";
import { useMenuOwner } from "../../navigation/menuScope";

export interface ThreadSheetRow {
  readonly key: string;
  readonly label: string;
  readonly subtitle?: string | null;
  /** Dimmed and inert: a status line, or an action that cannot run now. Still a focus stop. */
  readonly disabled?: boolean;
  readonly tone?: "default" | "danger" | "accent";
  /** A status dot before the label. */
  readonly dotColor?: string;
  /** Without one the row is still a focus stop, so a long read-only list scrolls. */
  readonly onPress?: () => void;
}

/** A focusable list over the right of the conversation. Focus stays inside, and Menu calls `onClose`. */
export function ThreadSheet(props: {
  readonly title: string;
  readonly subtitle?: string | null;
  readonly notice?: { readonly text: string; readonly tone: "muted" | "danger" } | null;
  readonly rows: ReadonlyArray<ThreadSheetRow>;
  /** Shown as the only row when `rows` is empty, so focus has somewhere to stay. */
  readonly emptyLabel?: string;
  /** Above the rows, such as a text field. */
  readonly children?: ReactNode;
  readonly onClose: () => void;
}) {
  useMenuOwner("sheet", props.onClose);

  // Every row is a focus stop: with none, focus would leave the trap.
  const rows: ReadonlyArray<ThreadSheetRow> =
    props.rows.length > 0
      ? props.rows
      : [{ key: "empty", label: props.emptyLabel ?? "Nothing here" }];
  const preferredKey = (rows.find((row) => !row.disabled) ?? rows[0]!).key;
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
        {props.children}
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {rows.map((row) => (
            <SheetRow key={row.key} row={row} preferred={row.key === preferredKey} />
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
  // Not Pressable's `disabled`: tvOS skips disabled views, so a sheet of them would lose focus.
  const onPress = row.disabled ? undefined : row.onPress;
  return (
    <FocusablePressable
      style={[styles.row, row.disabled && styles.disabledRow]}
      hasTVPreferredFocus={props.preferred}
      {...(onPress ? { onPress } : {})}
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
  disabledRow: { opacity: 0.5 },
  rowContent: { flexDirection: "row", alignItems: "center", gap: 16 },
  rowText: { flex: 1, gap: 4 },
  rowLabel: { ...typography.body, fontWeight: "600" },
  rowSubtitle: { color: colors.textMuted, ...typography.small },
  dot: { width: 14, height: 14, borderRadius: 7 },
  hint: { color: colors.textMuted, ...typography.small, textAlign: "right" },
});
