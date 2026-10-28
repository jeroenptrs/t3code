/**
 * The default dark theme of apps/mobile (generated-uniwind-themes.css), so the TV reads as the
 * same product. Focus has no mobile counterpart: it is the accent ring FocusablePressable draws.
 */
export const colors = {
  /** --color-screen */
  background: "#0a0a0a",
  /** --color-card */
  surface: "#111111",
  /** --color-thread-selected, also grouped surfaces */
  selected: "#1a1b1b",
  /** --color-row-hover; a focused row's fill */
  rowHover: "#141414",
  /** A focused control's fill: the selected tone, so a focused button reads above a card. */
  surfaceFocused: "#1a1b1b",
  /** --color-user-bubble */
  userBubble: "#161616",
  /** --color-border */
  border: "#191919",
  /** --color-input-border, also the composer's border */
  inputBorder: "#1e1e1e",
  /** --color-primary */
  accent: "#346bf1",
  /** --color-primary-text: links and accent text */
  accentText: "#4b7cf3",
  /** --color-foreground */
  text: "#f5f5f5",
  /** --color-foreground-muted */
  textMuted: "#838383",
  /** --color-foreground-tertiary */
  textTertiary: "#818181",
  /** --color-thread-selected-foreground */
  selectedText: "#f1f3f7",
  /** --color-thread-selected-foreground-muted */
  selectedTextMuted: "#a3a3a3",
  /** --color-warning-foreground */
  warning: "#ffb900",
  /** --color-danger-foreground */
  danger: "#ff6467",
  /** --color-update-foreground */
  update: "#51a2ff",
  /** adaptive-emerald-700-300 */
  success: "#5ee9b5",
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

/** Pull request state colours from mobile's PR badge: adaptive-{emerald,violet,rose}-600-400. */
export const pullRequestColors = {
  open: "#00d492",
  merged: "#a684ff",
  closed: "#ff637e",
  pending: "#838383",
} as const;

// apps/mobile/global.css's type scale, multiplied for a couch at 1920x1080: mobile's 16px body
// becomes 30, and every step keeps its ratio to it.
const TV_SCALE = 1.875;
const step = (fontSize: number, lineHeight: number) => ({
  fontSize: Math.round(fontSize * TV_SCALE),
  lineHeight: Math.round(lineHeight * TV_SCALE),
});

export const typeScale = {
  xs: step(13, 17),
  sm: step(14, 19),
  base: step(16, 23),
  lg: step(18, 23),
  xl: step(21, 28),
  "2xl": step(26, 32),
  "3xl": step(30, 36),
} as const;

/** Reading sizes for text viewed from a couch, on a 1920x1080 layout. */
export const typography = {
  body: typeScale.base,
  small: typeScale.xs,
  code: typeScale.sm,
  heading1: typeScale["2xl"],
  heading2: typeScale.xl,
  heading3: typeScale.lg,
  monospaceFamily: "Menlo",
} as const;

/** Mobile's conversation shapes, for the thread view. */
export const conversation = {
  userBubble: { backgroundColor: colors.userBubble, borderRadius: 20 * TV_SCALE },
  composer: { backgroundColor: colors.surface, borderColor: colors.inputBorder },
} as const;
