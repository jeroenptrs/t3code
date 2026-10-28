/**
 * A line-oriented reader for terminal output, for a renderer with no terminal emulator. It keeps
 * SGR styling, carriage returns, backspaces, and erase-in-line, and drops every other control
 * sequence: cursor movement, screen clears, and modes. Full-screen programs come out garbled.
 */

export const DEFAULT_FOREGROUND = "#c6c6c8";
export const DEFAULT_BACKGROUND = "#0a0a0a";
export const MAX_TERMINAL_LINES = 2000;

const PALETTE_16 = [
  "#3a3a3d",
  "#ff2e3f",
  "#0dbe4e",
  "#ffca00",
  "#009fff",
  "#c635e4",
  "#08c0ef",
  "#c6c6c8",
  "#77777d",
  "#ff6b77",
  "#4ade80",
  "#ffdd55",
  "#5cc0ff",
  "#e07bf2",
  "#5fdcfa",
  "#f4f4f6",
] as const;

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

const hex = (value: number) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
const rgb = (r: number, g: number, b: number) => `#${hex(r)}${hex(g)}${hex(b)}`;

export function xterm256Color(index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null;
  if (index < 16) return PALETTE_16[index]!;
  if (index < 232) {
    const cube = index - 16;
    return rgb(
      CUBE_LEVELS[Math.floor(cube / 36)]!,
      CUBE_LEVELS[Math.floor(cube / 6) % 6]!,
      CUBE_LEVELS[cube % 6]!,
    );
  }
  const gray = 8 + (index - 232) * 10;
  return rgb(gray, gray, gray);
}

export interface AnsiStyle {
  readonly foreground: string | null;
  readonly background: string | null;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly inverse: boolean;
}

export const PLAIN_STYLE: AnsiStyle = Object.freeze({
  foreground: null,
  background: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
});

export interface AnsiSpan {
  readonly text: string;
  readonly style: AnsiStyle;
}

export interface AnsiLine {
  /** Increases by one per line for the life of the parser, so it is a stable key. */
  readonly id: number;
  readonly spans: ReadonlyArray<AnsiSpan>;
}

/** Applies one SGR parameter list. Returns `style` itself when nothing changed. */
export function applySgr(style: AnsiStyle, params: ReadonlyArray<string>): AnsiStyle {
  let next = style;
  const set = (patch: Partial<AnsiStyle>) => {
    next = { ...next, ...patch };
  };
  const list = params.length === 0 ? [""] : params;
  for (let index = 0; index < list.length; index += 1) {
    const raw = list[index]!;
    // ITU T.416 colon form: 38:5:n or 38:2:[colorspace:]r:g:b in a single parameter.
    const sub = raw.includes(":") ? raw.split(":") : null;
    const code = raw === "" ? 0 : Number.parseInt(sub ? sub[0]! : raw, 10);
    if (code === 38 || code === 48) {
      let color: string | null = null;
      if (sub) {
        const values = sub.slice(1).map((part) => Number.parseInt(part || "0", 10));
        if (values[0] === 5) color = xterm256Color(values[1] ?? -1);
        else if (values[0] === 2) {
          const channels = values.length >= 5 ? values.slice(2, 5) : values.slice(1, 4);
          color = rgb(channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0);
        }
      } else {
        const mode = Number.parseInt(list[index + 1] ?? "", 10);
        if (mode === 5) {
          color = xterm256Color(Number.parseInt(list[index + 2] ?? "", 10));
          index += 2;
        } else if (mode === 2) {
          const [r, g, b] = [2, 3, 4].map((offset) =>
            Number.parseInt(list[index + offset] ?? "0", 10),
          );
          color = rgb(r || 0, g || 0, b || 0);
          index += 4;
        } else {
          index += 1;
        }
      }
      if (color !== null) set(code === 38 ? { foreground: color } : { background: color });
      continue;
    }
    if (code === 0) next = PLAIN_STYLE;
    else if (code === 1) set({ bold: true });
    else if (code === 2) set({ dim: true });
    else if (code === 3) set({ italic: true });
    else if (code === 4) set({ underline: true });
    else if (code === 7) set({ inverse: true });
    else if (code === 22) set({ bold: false, dim: false });
    else if (code === 23) set({ italic: false });
    else if (code === 24) set({ underline: false });
    else if (code === 27) set({ inverse: false });
    else if (code >= 30 && code <= 37) set({ foreground: PALETTE_16[code - 30]! });
    else if (code === 39) set({ foreground: null });
    else if (code >= 40 && code <= 47) set({ background: PALETTE_16[code - 40]! });
    else if (code === 49) set({ background: null });
    else if (code >= 90 && code <= 97) set({ foreground: PALETTE_16[code - 90 + 8]! });
    else if (code >= 100 && code <= 107) set({ background: PALETTE_16[code - 100 + 8]! });
  }
  return next;
}

type ParserState = "ground" | "escape" | "escapeIntermediate" | "csi" | "string" | "stringEscape";

export interface AnsiParser {
  write(data: string): void;
  /** Drops every line, as after a terminal clear or a new output generation. */
  reset(): void;
  /**
   * The retained lines, the unfinished one last. Unchanged lines keep their identity between
   * calls, so a renderer can skip them.
   */
  lines(): ReadonlyArray<AnsiLine>;
}

export function createAnsiParser(maxLines = MAX_TERMINAL_LINES): AnsiParser {
  let committed: AnsiLine[] = [];
  let nextId = 0;
  let chars: string[] = [];
  let styles: AnsiStyle[] = [];
  let column = 0;
  let style = PLAIN_STYLE;
  let state: ParserState = "ground";
  let sequence = "";
  let currentLine: AnsiLine | null = null;

  const toSpans = (): AnsiSpan[] => {
    const spans: AnsiSpan[] = [];
    let text = "";
    let spanStyle: AnsiStyle | null = null;
    for (let index = 0; index < chars.length; index += 1) {
      const cellStyle = styles[index]!;
      if (cellStyle !== spanStyle) {
        if (spanStyle !== null && text.length > 0) spans.push({ text, style: spanStyle });
        text = "";
        spanStyle = cellStyle;
      }
      text += chars[index];
    }
    if (spanStyle !== null && text.length > 0) spans.push({ text, style: spanStyle });
    return spans;
  };

  const touch = () => {
    currentLine = null;
  };

  const put = (char: string) => {
    while (chars.length < column) {
      chars.push(" ");
      styles.push(PLAIN_STYLE);
    }
    chars[column] = char;
    styles[column] = style;
    column += 1;
    touch();
  };

  const newline = () => {
    committed.push({ id: nextId, spans: toSpans() });
    nextId += 1;
    chars = [];
    styles = [];
    column = 0;
    touch();
    // Trim in batches so a long stream does not shift the array on every line.
    if (committed.length > maxLines + 200) committed = committed.slice(-(maxLines - 1));
  };

  const eraseInLine = (mode: number) => {
    if (mode === 0) {
      chars.length = Math.min(chars.length, column);
      styles.length = chars.length;
    } else if (mode === 1) {
      for (let index = 0; index < Math.min(column + 1, chars.length); index += 1) {
        chars[index] = " ";
        styles[index] = PLAIN_STYLE;
      }
    } else if (mode === 2) {
      chars = [];
      styles = [];
    }
    touch();
  };

  const finishCsi = (body: string, final: string) => {
    const privateMarker = body.length > 0 && /[<=>?]/.test(body[0]!);
    if (privateMarker) return;
    const params = body.replace(/[\x20-\x2f]+$/, "");
    if (final === "m") {
      style = applySgr(style, params === "" ? [] : params.split(";"));
    } else if (final === "K") {
      eraseInLine(params === "" ? 0 : Number.parseInt(params, 10) || 0);
    }
  };

  const write = (data: string) => {
    for (let index = 0; index < data.length; index += 1) {
      const char = data[index]!;
      const code = data.charCodeAt(index);
      switch (state) {
        case "ground":
          if (code === 0x1b) state = "escape";
          else if (code === 0x0a) newline();
          else if (code === 0x0d) column = 0;
          else if (code === 0x08) column = Math.max(0, column - 1);
          else if (code === 0x09) {
            const spaces = 8 - (column % 8);
            for (let count = 0; count < spaces; count += 1) put(" ");
          } else if (code === 0x9b) {
            state = "csi";
            sequence = "";
          } else if (code >= 0x20 && code !== 0x7f) put(char);
          break;
        case "escape":
          if (char === "[") {
            state = "csi";
            sequence = "";
          } else if (char === "]" || char === "P" || char === "X" || char === "^" || char === "_") {
            state = "string";
          } else if (code >= 0x20 && code <= 0x2f) {
            state = "escapeIntermediate";
          } else {
            state = "ground";
          }
          break;
        case "escapeIntermediate":
          if (code < 0x20 || code > 0x2f) state = "ground";
          break;
        case "csi":
          if (code >= 0x40 && code <= 0x7e) {
            finishCsi(sequence, char);
            state = "ground";
          } else if (code === 0x1b) {
            state = "escape";
          } else if (code >= 0x20) {
            sequence += char;
          } else if (code === 0x18 || code === 0x1a) {
            state = "ground";
          }
          break;
        case "string":
          if (code === 0x07) state = "ground";
          else if (code === 0x1b) state = "stringEscape";
          break;
        case "stringEscape":
          state = char === "\\" ? "ground" : "string";
          break;
      }
    }
  };

  return {
    write,
    reset: () => {
      committed = [];
      chars = [];
      styles = [];
      column = 0;
      style = PLAIN_STYLE;
      state = "ground";
      sequence = "";
      touch();
    },
    lines: () => {
      currentLine ??= { id: nextId, spans: toSpans() };
      const tail = committed.length >= maxLines ? committed.slice(-(maxLines - 1)) : committed;
      return [...tail, currentLine];
    },
  };
}

/** The colours a span draws with, with inverse and defaults resolved. */
export function resolveSpanColors(style: AnsiStyle): {
  readonly color: string;
  readonly backgroundColor: string | undefined;
} {
  if (!style.inverse) {
    return {
      color: style.foreground ?? DEFAULT_FOREGROUND,
      backgroundColor: style.background ?? undefined,
    };
  }
  return {
    color: style.background ?? DEFAULT_BACKGROUND,
    backgroundColor: style.foreground ?? DEFAULT_FOREGROUND,
  };
}
