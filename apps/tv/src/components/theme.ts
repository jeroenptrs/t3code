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

/**
 * Thread status colours, the dark values of the tokens apps/mobile's thread rows use
 * (STATUS_LABEL_BY_STATUS in features/threads/thread-list-v2-items.tsx, values from
 * generated-uniwind-themes.css).
 */
export const statusColors = {
  /** warning-foreground */
  approval: "#ffb900",
  /** adaptive-indigo-600-300 */
  input: "#a3b3ff",
  /** adaptive-fuchsia-600-300 */
  request: "#f4a8ff",
  /** adaptive-sky-600-400 */
  working: "#00bcff",
  /** foreground-muted */
  waiting: "#838383",
  /** danger-foreground */
  failed: "#ff6467",
  /** warning-foreground */
  limited: "#ffb900",
  /** adaptive-emerald-700-300 */
  done: "#5ee9b5",
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
