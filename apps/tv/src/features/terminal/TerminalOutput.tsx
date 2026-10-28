import { memo, useCallback, useRef } from "react";
import { ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from "react-native";

import { FocusablePressable } from "../../components/FocusablePressable";
import { colors, typography } from "../../components/theme";
import { DEFAULT_BACKGROUND, resolveSpanColors, type AnsiLine, type AnsiSpan } from "./ansi";

/** Lines per focus stop: the remote scrolls the output a chunk at a time. */
const LINES_PER_CHUNK = 20;
export const TERMINAL_FONT_SIZE = 20;
export const TERMINAL_LINE_HEIGHT = 26;
/** Menlo's advance is 0.6 em. */
export const TERMINAL_GLYPH_WIDTH = TERMINAL_FONT_SIZE * 0.6;
export const TERMINAL_HORIZONTAL_PADDING = 24;

function chunkLines(lines: ReadonlyArray<AnsiLine>): ReadonlyArray<ReadonlyArray<AnsiLine>> {
  const chunks: AnsiLine[][] = [];
  for (const line of lines) {
    // Grouping by id keeps a chunk's key and membership stable as old lines are dropped.
    const last = chunks.at(-1);
    if (last && Math.floor(last[0]!.id / LINES_PER_CHUNK) === Math.floor(line.id / LINES_PER_CHUNK))
      last.push(line);
    else chunks.push([line]);
  }
  return chunks;
}

function SpanText(props: { readonly span: AnsiSpan }) {
  const { style } = props.span;
  const { color, backgroundColor } = resolveSpanColors(style);
  return (
    <Text
      style={{
        color,
        backgroundColor,
        fontWeight: style.bold ? "700" : undefined,
        opacity: style.dim ? 0.6 : undefined,
        fontStyle: style.italic ? "italic" : undefined,
        textDecorationLine: style.underline ? "underline" : undefined,
      }}
    >
      {props.span.text}
    </Text>
  );
}

function LineSpans(props: { readonly spans: ReadonlyArray<AnsiSpan> }) {
  let column = 0;
  return props.spans.map((span) => {
    const start = column;
    column += span.text.length;
    return <SpanText key={start} span={span} />;
  });
}

const Chunk = memo(
  function Chunk(props: {
    readonly lines: ReadonlyArray<AnsiLine>;
    readonly isLast: boolean;
    readonly onFocusChunk: (isLast: boolean) => void;
  }) {
    return (
      <FocusablePressable
        style={styles.chunk}
        focusedStyle={styles.chunkFocused}
        onFocus={() => props.onFocusChunk(props.isLast)}
      >
        <Text style={styles.text}>
          {props.lines.map((line, index) => (
            <Text key={line.id}>
              <LineSpans spans={line.spans} />
              {index < props.lines.length - 1 ? "\n" : ""}
            </Text>
          ))}
        </Text>
      </FocusablePressable>
    );
  },
  (previous, next) =>
    previous.isLast === next.isLast &&
    previous.onFocusChunk === next.onFocusChunk &&
    previous.lines.length === next.lines.length &&
    previous.lines.every((line, index) => line === next.lines[index]),
);

/**
 * The output, as focus stops of a few lines each. It follows new output until the viewer moves
 * focus to an earlier chunk, and follows again once focus is back on the last one or below it.
 */
export function TerminalOutput(props: {
  readonly lines: ReadonlyArray<AnsiLine>;
  readonly followingRef: { current: boolean };
  readonly emptyLabel: string;
}) {
  const scrollRef = useRef<ScrollViewInstance>(null);
  const { followingRef } = props;
  const onFocusChunk = useCallback(
    (isLast: boolean) => {
      followingRef.current = isLast;
    },
    [followingRef],
  );
  const chunks = chunkLines(props.lines);
  const hasText = props.lines.some((line) => line.spans.length > 0);
  return (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={styles.content}
      onContentSizeChange={() => {
        if (followingRef.current) scrollRef.current?.scrollToEnd({ animated: false });
      }}
    >
      {hasText ? (
        chunks.map((lines, index) => (
          <Chunk
            key={Math.floor(lines[0]!.id / LINES_PER_CHUNK)}
            lines={lines}
            isLast={index === chunks.length - 1}
            onFocusChunk={onFocusChunk}
          />
        ))
      ) : (
        <View style={styles.empty}>
          <Text style={styles.emptyLabel}>{props.emptyLabel}</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: DEFAULT_BACKGROUND, borderRadius: 12 },
  content: { paddingVertical: 12, paddingHorizontal: TERMINAL_HORIZONTAL_PADDING - 3 },
  chunk: { backgroundColor: "transparent", borderRadius: 6 },
  chunkFocused: { backgroundColor: "#16161c", borderColor: colors.surfaceFocused },
  text: {
    fontFamily: typography.monospaceFamily,
    fontSize: TERMINAL_FONT_SIZE,
    lineHeight: TERMINAL_LINE_HEIGHT,
  },
  empty: { padding: 24 },
  emptyLabel: { color: colors.textMuted, ...typography.small },
});
