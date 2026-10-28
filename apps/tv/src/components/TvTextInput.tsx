import { StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";

import { colors, typography } from "./theme";

/**
 * A labelled text field that leaves the look to tvOS. UITextField draws its own capsule,
 * focus lift, and shadow, so neither the input nor its wrapper gets a border or background.
 * Width comes from the parent.
 */
export function TvTextInput(
  props: Omit<TextInputProps, "style" | "placeholderTextColor"> & { readonly label?: string },
) {
  const { label, ...inputProps } = props;
  // Nothing here may change with focus: a style that adds a stacking context (transform,
  // opacity) to the input's parent re-parents the native field and dismisses the keyboard.
  return (
    <View style={styles.root}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput {...inputProps} style={styles.input} placeholderTextColor={colors.textMuted} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12 },
  label: { color: colors.textMuted, ...typography.small },
  input: { color: colors.text, fontSize: 30, height: 88, paddingHorizontal: 28 },
});
