import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { colors } from "./theme";

/**
 * A Pressable that shows where the Siri Remote's focus is. The ring sits inside its bounds and
 * there is no scale, so a focused item in a list is never overlapped by the sibling after it.
 */
export function FocusablePressable(props: {
  readonly onPress?: () => void;
  readonly onFocus?: () => void;
  readonly disabled?: boolean;
  readonly hasTVPreferredFocus?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly focusedStyle?: StyleProp<ViewStyle>;
  readonly children: ReactNode | ((state: { readonly focused: boolean }) => ReactNode);
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      disabled={props.disabled}
      hasTVPreferredFocus={props.hasTVPreferredFocus}
      onPress={props.onPress}
      onFocus={() => {
        setFocused(true);
        props.onFocus?.();
      }}
      onBlur={() => setFocused(false)}
      style={[
        styles.base,
        props.style,
        focused && styles.focused,
        focused && props.focusedStyle,
        props.disabled && styles.disabled,
      ]}
    >
      {typeof props.children === "function" ? props.children({ focused }) : props.children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 3,
    borderColor: "transparent",
  },
  focused: {
    backgroundColor: colors.surfaceFocused,
    borderColor: colors.accent,
  },
  disabled: { opacity: 0.5 },
});
