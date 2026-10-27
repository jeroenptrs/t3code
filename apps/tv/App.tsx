// @effect-diagnostics globalConsole:off - spike: logs focus events to Metro.
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

export default function App() {
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.root}>
      <Text style={styles.title}>T3 Code TV</Text>
      <Pressable
        onFocus={() => {
          console.log("[tv] button focused");
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onPress={() => console.log("[tv] button pressed")}
        style={[styles.button, focused && styles.buttonFocused]}
      >
        <Text style={styles.buttonLabel}>{focused ? "Focused" : "Not focused"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0b0b0f" },
  title: { color: "white", fontSize: 72, fontWeight: "700", marginBottom: 48 },
  button: {
    paddingHorizontal: 48,
    paddingVertical: 24,
    borderRadius: 16,
    backgroundColor: "#2a2a33",
  },
  buttonFocused: { backgroundColor: "#5b5bf0", transform: [{ scale: 1.1 }] },
  buttonLabel: { color: "white", fontSize: 36 },
});
