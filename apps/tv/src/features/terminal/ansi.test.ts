import { describe, expect, it } from "vite-plus/test";

import { createAnsiParser, PLAIN_STYLE, xterm256Color, type AnsiLine } from "./ansi";

const text = (line: AnsiLine) => line.spans.map((span) => span.text).join("");
const parse = (...chunks: string[]) => {
  const parser = createAnsiParser();
  for (const chunk of chunks) parser.write(chunk);
  return parser.lines();
};

describe("createAnsiParser", () => {
  it("rewrites a progress line on carriage return and keeps only its last state", () => {
    const lines = parse("start\r\n", "progress  10%\r", "progress  55%\r", "progress 100%\r\ndone");
    expect(lines.map(text)).toEqual(["start", "progress 100%", "done"]);
  });

  it("keeps the tail of a longer line that a shorter rewrite does not cover", () => {
    expect(parse("abcdef\rXY").map(text)).toEqual(["XYcdef"]);
    expect(parse("abcdef\rXY\x1b[K").map(text)).toEqual(["XY"]);
  });

  it("moves back on backspace and overwrites", () => {
    expect(parse("spin|\b/\b-").map(text)).toEqual(["spin-"]);
  });

  it("splits styled spans and resets colours", () => {
    const [line] = parse("\x1b[1;31merror\x1b[0m: \x1b[32mok\x1b[39m plain");
    expect(line!.spans.map((span) => span.text)).toEqual(["error", ": ", "ok", " plain"]);
    expect(line!.spans[0]!.style).toMatchObject({ bold: true, foreground: "#ff2e3f" });
    expect(line!.spans[1]!.style).toBe(PLAIN_STYLE);
    expect(line!.spans[2]!.style.foreground).toBe("#0dbe4e");
    expect(line!.spans[3]!.style.foreground).toBeNull();
  });

  it("maps 256-colour and truecolour to RGB, in both parameter forms", () => {
    const [line] = parse(
      "\x1b[38;5;196ma\x1b[38;2;1;2;3mb\x1b[48:2::16:32:48mc\x1b[38:5:244md\x1b[2;3me",
    );
    const styles = line!.spans.map((span) => span.style);
    expect(styles[0]!.foreground).toBe("#ff0000");
    expect(styles[1]!.foreground).toBe("#010203");
    expect(styles[2]!.background).toBe("#102030");
    expect(styles[3]!.foreground).toBe(xterm256Color(244));
    expect(styles[4]).toMatchObject({ dim: true, italic: true });
  });

  it("strips OSC titles, private modes, and cursor movement, even split across chunks", () => {
    const lines = parse("\x1b]0;my ti", "tle\x07\x1b[?2004h$ l", "s\x1b[2", "A\x1b[10Gx\x1b(B\r\n");
    expect(lines.map(text)).toEqual(["$ lsx", ""]);
  });

  it("keeps unchanged lines by identity and the newest lines past the cap", () => {
    const parser = createAnsiParser(3);
    parser.write("a\nb\n");
    const first = parser.lines();
    parser.write("c");
    const second = parser.lines();
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    parser.write("\nd\ne");
    expect(parser.lines().map(text)).toEqual(["c", "d", "e"]);
  });
});
