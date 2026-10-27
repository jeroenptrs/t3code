export const colors = {
  background: "#0b0b0f",
  surface: "#17171d",
  surfaceFocused: "#2b2b38",
  accent: "#6d6df5",
  text: "#f4f4f6",
  textMuted: "#9a9aa6",
  danger: "#ff6b6b",
  success: "#4ade80",
  warning: "#facc15",
} as const;

/** Reading sizes for text viewed from a couch, on a 1920x1080 layout. */
export const typography = {
  body: { fontSize: 30, lineHeight: 46 },
  small: { fontSize: 24, lineHeight: 34 },
  code: { fontSize: 25, lineHeight: 38 },
  heading1: { fontSize: 44, lineHeight: 58 },
  heading2: { fontSize: 38, lineHeight: 52 },
  heading3: { fontSize: 34, lineHeight: 48 },
  monospaceFamily: "Menlo",
} as const;
