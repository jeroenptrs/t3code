import { memo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { colors } from "./theme";

/**
 * A focus stop for read-only content. A tvOS ScrollView moves only between focusable children,
 * so a feed made of these scrolls with the remote one block at a time.
 */
export const FocusableBlock = memo(function FocusableBlock(props: {
  readonly style?: StyleProp<ViewStyle>;
  readonly hasTVPreferredFocus?: boolean;
  readonly children: ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      hasTVPreferredFocus={props.hasTVPreferredFocus}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[styles.base, props.style, focused && styles.focused]}
    >
      {props.children}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  base: {
    borderLeftWidth: 6,
    borderLeftColor: "transparent",
    paddingLeft: 24,
    borderRadius: 4,
  },
  focused: {
    borderLeftColor: colors.accent,
    backgroundColor: "rgba(109, 109, 245, 0.08)",
  },
});
