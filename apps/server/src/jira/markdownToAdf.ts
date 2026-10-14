/**
 * Markdown to Atlassian Document Format, the inverse of `adfToMarkdown.ts`.
 *
 * Covers the node and mark types that `adfToMarkdown` renders from markdown syntax:
 * paragraph, heading, bullet/ordered lists (nested), code blocks, blockquote, rule, table,
 * hard breaks, inline cards (`<https://...>`) and the strong/em/strike/code/link marks.
 * Anything else (HTML, task lists, reference links, ...) stays literal text, so no text is
 * ever dropped.
 */

type MarkType = "strong" | "em" | "strike" | "code";

type AdfMark =
  | { readonly type: MarkType }
  | { readonly type: "link"; readonly attrs: { readonly href: string } };

export type AdfInline =
  | { readonly type: "text"; readonly text: string; readonly marks?: ReadonlyArray<AdfMark> }
  | { readonly type: "hardBreak" }
  | { readonly type: "inlineCard"; readonly attrs: { readonly url: string } };

export interface AdfBlock {
  readonly type:
    | "paragraph"
    | "heading"
    | "bulletList"
    | "orderedList"
    | "listItem"
    | "codeBlock"
    | "blockquote"
    | "rule"
    | "table"
    | "tableRow"
    | "tableHeader"
    | "tableCell";
  readonly attrs?: Readonly<Record<string, string | number | boolean>>;
  readonly content?: ReadonlyArray<AdfBlock | AdfInline>;
}

export interface AdfDoc {
  readonly type: "doc";
  readonly version: 1;
  readonly content: ReadonlyArray<AdfBlock>;
}

const isInline = (node: AdfBlock | AdfInline): node is AdfInline =>
  node.type === "text" || node.type === "hardBreak" || node.type === "inlineCard";

const blocksOf = (node: AdfBlock): AdfBlock[] =>
  (node.content ?? []).filter((child): child is AdfBlock => !isInline(child));

const inlinesOf = (node: AdfBlock): AdfInline[] => (node.content ?? []).filter(isInline);

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

type Delimiter = {
  readonly kind: "delim";
  readonly char: "*" | "_" | "~";
  readonly original: number;
  count: number;
  readonly canOpen: boolean;
  readonly canClose: boolean;
};

type Item =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "nodes"; readonly nodes: ReadonlyArray<AdfInline> }
  | Delimiter
  | { readonly kind: "wrap"; readonly mark: MarkType; readonly items: Item[] };

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const BARE_URL = /https?:\/\/[^\s<>`]+/y;
const AUTOLINK = /<(https?:\/\/[^\s<>]*)>/y;

/** Sticky match of `pattern` at exactly `at`, returning the whole match and first group. */
function matchAt(pattern: RegExp, source: string, at: number) {
  pattern.lastIndex = at;
  const match = pattern.exec(source);
  return match ? { text: match[0], group: match[1] } : null;
}
const LINKABLE = /^(?:https?|mailto|ftp|tel):/i;

const isSpace = (char: string) => char === "" || /\s/.test(char);
const isPunctuation = (char: string) => char !== "" && /[\p{P}\p{S}]/u.test(char);

/** CommonMark flanking rules: whether a delimiter run can open and/or close emphasis. */
function delimiterFlags(char: string, prev: string, next: string) {
  const left = !isSpace(next) && (!isPunctuation(next) || isSpace(prev) || isPunctuation(prev));
  const right = !isSpace(prev) && (!isPunctuation(prev) || isSpace(next) || isPunctuation(next));
  return char === "_"
    ? {
        canOpen: left && (!right || isPunctuation(prev)),
        canClose: right && (!left || isPunctuation(next)),
      }
    : { canOpen: left, canClose: right };
}

const textNode = (text: string, marks: ReadonlyArray<AdfMark> = []): AdfInline =>
  marks.length > 0 ? { type: "text", text, marks: [...marks] } : { type: "text", text };

/** Adds `mark` to a text node. `code` excludes every mark except `link` in ADF. */
function withMark(node: AdfInline, mark: AdfMark): AdfInline {
  if (node.type !== "text") return node;
  const marks = node.marks ?? [];
  if (marks.some((existing) => existing.type === mark.type)) return node;
  if (mark.type !== "link" && marks.some((existing) => existing.type === "code")) return node;
  return textNode(node.text, [...marks, mark]);
}

/** Applies matched emphasis pairs (CommonMark's delimiter-stack algorithm, left to right). */
function resolveEmphasis(items: Item[]): void {
  for (let c = 0; c < items.length; c++) {
    const closer = items[c];
    if (closer?.kind !== "delim" || !closer.canClose) continue;
    let o = c - 1;
    for (; o >= 0; o--) {
      const opener = items[o];
      if (
        opener?.kind === "delim" &&
        opener.char === closer.char &&
        opener.canOpen &&
        // "Rule of three": mixed open/close runs must not pair when their lengths sum to a multiple of 3.
        !(
          (opener.canClose || closer.canOpen) &&
          (opener.original + closer.original) % 3 === 0 &&
          !(opener.original % 3 === 0 && closer.original % 3 === 0)
        )
      ) {
        break;
      }
    }
    const opener = items[o];
    if (o < 0 || opener?.kind !== "delim") continue;

    const use = closer.char === "~" || (opener.count >= 2 && closer.count >= 2) ? 2 : 1;
    const mark: MarkType = closer.char === "~" ? "strike" : use === 2 ? "strong" : "em";
    items.splice(o + 1, c - o - 1, { kind: "wrap", mark, items: items.slice(o + 1, c) });
    opener.count -= use;
    closer.count -= use;

    // After the splice the wrap sits at o + 1 and the closer at o + 2.
    let position = o + 2;
    if (closer.count === 0) items.splice(position--, 1);
    if (opener.count === 0) {
      items.splice(o, 1);
      position--;
    }
    // A closer with leftovers is looked at again; otherwise continue after the wrap.
    c = closer.count > 0 ? position - 1 : position;
  }
}

function flatten(items: ReadonlyArray<Item>, marks: ReadonlyArray<AdfMark>): AdfInline[] {
  return items.flatMap((item): AdfInline[] => {
    switch (item.kind) {
      case "text":
        return [textNode(item.value, marks)];
      case "delim":
        return [textNode(item.char.repeat(item.count), marks)];
      case "nodes":
        return item.nodes.map((node) => marks.reduce(withMark, node));
      case "wrap":
        return flatten(item.items, [...marks, { type: item.mark }]);
    }
  });
}

const sameMarks = (a: AdfInline, b: AdfInline) =>
  JSON.stringify(a.type === "text" ? (a.marks ?? []) : null) ===
  JSON.stringify(b.type === "text" ? (b.marks ?? []) : null);

/** Merges neighbouring text nodes with equal marks and drops empty ones. */
function normalizeInline(nodes: ReadonlyArray<AdfInline>): AdfInline[] {
  const out: AdfInline[] = [];
  for (const node of nodes) {
    if (node.type === "text" && node.text === "") continue;
    const last = out[out.length - 1];
    if (last?.type === "text" && node.type === "text" && sameMarks(last, node)) {
      out[out.length - 1] = textNode(last.text + node.text, last.marks);
    } else {
      out.push(node);
    }
  }
  while (out[0]?.type === "hardBreak") out.shift();
  while (out[out.length - 1]?.type === "hardBreak") out.pop();
  return out;
}

const unescape = (text: string) => text.replace(/\\([!-/:-@[-`{-~])/g, "$1");

interface LinkMatch {
  readonly end: number;
  readonly label: string;
  readonly href: string;
}

/** Matches `[label](destination "title")` starting at the `[` at `start`. */
function matchLink(source: string, start: number): LinkMatch | null {
  let depth = 0;
  let k = start;
  for (; k < source.length; k++) {
    const char = source.charAt(k);
    if (char === "\\") {
      k++;
    } else if (char === "`") {
      const run = /^`+/.exec(source.slice(k))?.[0] ?? "`";
      const close = source.indexOf(run, k + run.length);
      k = close === -1 ? k + run.length - 1 : close + run.length - 1;
    } else if (char === "[") {
      depth++;
    } else if (char === "]" && --depth === 0) {
      break;
    }
  }
  if (k >= source.length || source.charAt(k + 1) !== "(") return null;
  const label = source.slice(start + 1, k);

  let p = k + 2;
  const skipSpaces = () => {
    while (/\s/.test(source.charAt(p)) && p < source.length) p++;
  };
  skipSpaces();
  let href = "";
  if (source.charAt(p) === "<") {
    const close = source.indexOf(">", p);
    if (close === -1 || source.slice(p, close).includes("\n")) return null;
    href = source.slice(p + 1, close);
    p = close + 1;
  } else {
    let parens = 0;
    const from = p;
    for (; p < source.length; p++) {
      const char = source.charAt(p);
      if (char === "\\") p++;
      else if (/\s/.test(char)) break;
      else if (char === "(") parens++;
      else if (char === ")" && parens-- === 0) break;
    }
    href = source.slice(from, p);
  }
  skipSpaces();
  const quote = source.charAt(p);
  if (quote === '"' || quote === "'" || quote === "(") {
    const closing = quote === "(" ? ")" : quote;
    let q = p + 1;
    for (; q < source.length && source.charAt(q) !== closing; q++) {
      if (source.charAt(q) === "\\") q++;
    }
    if (q >= source.length) return null;
    p = q + 1;
    skipSpaces();
  }
  return source.charAt(p) === ")" ? { end: p + 1, label, href: unescape(href) } : null;
}

/** A link item, or its label followed by the destination when Jira would reject the href. */
function linkItem(label: AdfInline[], href: string): Item {
  const nodes = label.length > 0 ? label : [textNode(href)];
  if (LINKABLE.test(href)) {
    const mark: AdfMark = { type: "link", attrs: { href: href.replace(/ /g, "%20") } };
    return { kind: "nodes", nodes: nodes.map((node) => withMark(node, mark)) };
  }
  return {
    kind: "nodes",
    nodes: href && label.length > 0 ? [...nodes, textNode(` (${href})`)] : nodes,
  };
}

/** Trims punctuation that belongs to the sentence around a bare URL, not to the URL. */
function trimUrl(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url.charAt(end - 1);
    const head = url.slice(0, end);
    const unbalancedParen =
      last === ")" && (head.match(/\)/g)?.length ?? 0) > (head.match(/\(/g)?.length ?? 0);
    if (/[.,;:!?'"*_~]/.test(last) || unbalancedParen) end--;
    else return url.slice(0, end);
  }
}

function parseInline(source: string, inLink = false): AdfInline[] {
  const items: Item[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) items.push({ kind: "text", value: buffer });
    buffer = "";
  };
  const push = (item: Item) => {
    flush();
    items.push(item);
  };

  let i = 0;
  while (i < source.length) {
    const char = source.charAt(i);

    if (char === "\\") {
      const next = source.charAt(i + 1);
      if (next === "\n") {
        push({ kind: "nodes", nodes: [{ type: "hardBreak" }] });
        i += 2;
        while (/[ \t]/.test(source.charAt(i))) i++;
      } else if (ASCII_PUNCTUATION.test(next)) {
        buffer += next;
        i += 2;
      } else {
        buffer += char;
        i++;
      }
    } else if (char === "\n") {
      // Every line break becomes a hard break: agents write "Key: value" lines meaning them.
      buffer = buffer.replace(/ +$/, "");
      push({ kind: "nodes", nodes: [{ type: "hardBreak" }] });
      i++;
      while (/[ \t]/.test(source.charAt(i))) i++;
    } else if (char === "`") {
      const run = /^`+/.exec(source.slice(i))?.[0] ?? "`";
      let close = -1;
      for (let j = i + run.length; ;) {
        const at = source.indexOf("`", j);
        if (at === -1) break;
        const length = /^`+/.exec(source.slice(at))?.[0].length ?? 1;
        if (length === run.length) {
          close = at;
          break;
        }
        j = at + length;
      }
      if (close === -1) {
        buffer += run;
        i += run.length;
      } else {
        let code = source.slice(i + run.length, close).replace(/\n/g, " ");
        if (code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") {
          code = code.slice(1, -1);
        }
        push({ kind: "nodes", nodes: [textNode(code, [{ type: "code" }])] });
        i = close + run.length;
      }
    } else if (!inLink && (char === "[" || (char === "!" && source.charAt(i + 1) === "["))) {
      const isImage = char === "!";
      const match = matchLink(source, isImage ? i + 1 : i);
      if (match) {
        // Images have no ADF equivalent here; they become a link labelled with the alt text.
        const label = normalizeInline(parseInline(match.label, true));
        push(linkItem(label, match.href));
        i = match.end;
      } else {
        buffer += char;
        i++;
      }
    } else if (char === "<") {
      const url = matchAt(AUTOLINK, source, i)?.group;
      if (url) {
        push({ kind: "nodes", nodes: [{ type: "inlineCard", attrs: { url } }] });
        i += url.length + 2;
      } else {
        buffer += char;
        i++;
      }
    } else if (char === "*" || char === "_" || char === "~") {
      let end = i;
      while (source.charAt(end) === char) end++;
      const count = end - i;
      const flags = delimiterFlags(char, source.charAt(i - 1), source.charAt(end));
      if ((char === "~" && count !== 2) || (!flags.canOpen && !flags.canClose)) {
        buffer += char.repeat(count);
      } else {
        push({ kind: "delim", char, original: count, count, ...flags });
      }
      i = end;
    } else {
      const bare =
        char === "h" && !inLink && !/[\p{L}\p{N}]/u.test(source.charAt(i - 1))
          ? matchAt(BARE_URL, source, i)
          : null;
      if (bare) {
        const url = trimUrl(bare.text);
        push(linkItem([textNode(url)], url));
        i += url.length;
      } else {
        buffer += char;
        i++;
      }
    }
  }
  flush();

  resolveEmphasis(items);
  return normalizeInline(flatten(items, []));
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const HEADING = /^\s*(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const RULE = /^\s*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^\s*>/;
const BULLET = /^(\s*)([-+*])([ \t]+)(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})([.)])([ \t]+)(.*)$/;
const DELIMITER_CELL = /^:?-+:?$/;

const isBlank = (line: string | undefined) => !line?.trim();

/** Indentation in columns; a tab counts as four. */
function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") width++;
    else if (char === "\t") width += 4;
    else break;
  }
  return width;
}

/** Removes up to `columns` columns of leading whitespace. */
function stripIndent(line: string, columns: number): string {
  let used = 0;
  let k = 0;
  while (k < line.length && used < columns) {
    const char = line.charAt(k);
    if (char === " ") {
      used++;
    } else if (char === "\t") {
      if (used + 4 > columns) return " ".repeat(used + 4 - columns) + line.slice(k + 1);
      used += 4;
    } else {
      break;
    }
    k++;
  }
  return line.slice(k);
}

function matchFence(line: string) {
  const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const marker = match[1] ?? "";
  const info = match[2] ?? "";
  if (marker.startsWith("`") && info.includes("`")) return null;
  return { marker, indent: indentOf(line), language: info.trim().split(/\s+/)[0] ?? "" };
}

function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  const cells: string[] = [];
  let cell = "";
  for (let k = 0; k < text.length; k++) {
    const char = text.charAt(k);
    if (char === "\\" && text.charAt(k + 1) === "|") {
      cell += "|";
      k++;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  // A trailing pipe closes the last cell instead of opening an empty one.
  if (!(cell === "" && text.endsWith("|") && !text.endsWith("\\|"))) cells.push(cell.trim());
  return cells;
}

function isTableStart(lines: ReadonlyArray<string>, at: number): boolean {
  const line = lines[at] ?? "";
  const next = lines[at + 1] ?? "";
  if (!line.includes("|") || !next.includes("|")) return false;
  const delimiters = splitRow(next);
  return (
    delimiters.length === splitRow(line).length &&
    delimiters.every((cell) => DELIMITER_CELL.test(cell))
  );
}

const isListMarker = (line: string) => BULLET.test(line) || ORDERED.test(line);

/** Whether `lines[at]` begins a block, which ends a running paragraph. */
const startsBlock = (lines: ReadonlyArray<string>, at: number) => {
  const line = lines[at] ?? "";
  return (
    matchFence(line) !== null ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    isListMarker(line) ||
    isTableStart(lines, at)
  );
};

const paragraph = (inlines: ReadonlyArray<AdfInline>): AdfBlock => ({
  type: "paragraph",
  content: [...inlines],
});

/**
 * Block children ADF allows inside list items and blockquotes. Headings become paragraphs,
 * nested quotes are flattened and tables become one paragraph per row, so text survives.
 */
function toContainerBlocks(blocks: ReadonlyArray<AdfBlock>): AdfBlock[] {
  return blocks.flatMap((block): AdfBlock[] => {
    switch (block.type) {
      case "paragraph":
      case "bulletList":
      case "orderedList":
      case "codeBlock":
        return [block];
      case "heading":
        return [paragraph(inlinesOf(block))];
      case "blockquote":
        return blocksOf(block);
      case "table":
        return blocksOf(block).map((row) =>
          paragraph(
            normalizeInline(
              blocksOf(row).flatMap((cell, index) => [
                ...(index > 0 ? [textNode(" | ")] : []),
                ...blocksOf(cell).flatMap(inlinesOf),
              ]),
            ),
          ),
        );
      default:
        return [];
    }
  });
}

function parseList(lines: ReadonlyArray<string>, start: number): { block: AdfBlock; next: number } {
  const ordered = ORDERED.test(lines[start] ?? "");
  const firstNumber = Number(ORDERED.exec(lines[start] ?? "")?.[2] ?? 1);
  const items: AdfBlock[] = [];
  let i = start;

  for (;;) {
    const line = lines[i] ?? "";
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : ORDERED.exec(line);
    const match = bullet ?? numbered;
    const markerWidth = bullet ? 1 : (numbered?.[2]?.length ?? 0) + 1;
    const spacing = bullet ? (bullet[3] ?? " ") : (numbered?.[4] ?? " ");
    const content = (bullet ? bullet[4] : numbered?.[5]) ?? "";
    const gap = content.trim() === "" || indentOf(spacing) > 4 ? 1 : indentOf(spacing);
    const offset = indentOf(match?.[1] ?? "") + markerWidth + gap;

    const itemLines = [content];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j] ?? "";
      if (isBlank(next)) {
        let k = j + 1;
        while (k < lines.length && isBlank(lines[k])) k++;
        if (k < lines.length && indentOf(lines[k] ?? "") >= offset) {
          for (; j < k; j++) itemLines.push("");
          continue;
        }
        break;
      }
      if (indentOf(next) >= offset) {
        itemLines.push(stripIndent(next, offset));
      } else if (!isBlank(lines[j - 1]) && !startsBlock(lines, j)) {
        itemLines.push(next.trim()); // lazy paragraph continuation
      } else {
        break;
      }
      j++;
    }

    const children = toContainerBlocks(parseBlocks(itemLines));
    // ADF list items open with a paragraph.
    const body = children[0]?.type === "paragraph" ? children : [paragraph([]), ...children];
    items.push({ type: "listItem", content: body });
    i = j;

    let k = i;
    while (k < lines.length && isBlank(lines[k])) k++;
    const sibling = lines[k] ?? "";
    const continues =
      k < lines.length &&
      !RULE.test(sibling) &&
      (ordered ? ORDERED.test(sibling) : BULLET.test(sibling));
    if (!continues) break;
    i = k;
  }

  const block: AdfBlock = ordered
    ? {
        type: "orderedList",
        ...(firstNumber === 1 ? {} : { attrs: { order: firstNumber } }),
        content: items,
      }
    : { type: "bulletList", content: items };
  return { block, next: i };
}

function parseBlocks(lines: ReadonlyArray<string>): AdfBlock[] {
  const blocks: AdfBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = matchFence(line);
    if (fence) {
      const code: string[] = [];
      i++;
      for (; i < lines.length; i++) {
        const current = lines[i] ?? "";
        const closing = new RegExp(`^\\s*${fence.marker.charAt(0)}{${fence.marker.length},}\\s*$`);
        if (closing.test(current)) {
          i++;
          break;
        }
        code.push(stripIndent(current, fence.indent));
      }
      const text = code.join("\n");
      blocks.push({
        type: "codeBlock",
        ...(fence.language ? { attrs: { language: fence.language } } : {}),
        ...(text ? { content: [textNode(text)] } : {}),
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const text = (heading[2] ?? "").replace(/(?:^|[ \t]+)#+$/, "").trim();
      const content = parseInline(text);
      if (content.length > 0) {
        blocks.push({ type: "heading", attrs: { level: heading[1]?.length ?? 1 }, content });
      }
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? "";
        if (QUOTE.test(current)) {
          quoted.push(current.replace(/^\s*> ?/, ""));
        } else if (
          !isBlank(current) &&
          !isBlank(quoted[quoted.length - 1]) &&
          !startsBlock(lines, i)
        ) {
          quoted.push(current); // lazy continuation
        } else {
          break;
        }
        i++;
      }
      const content = toContainerBlocks(parseBlocks(quoted));
      if (content.length > 0) blocks.push({ type: "blockquote", content });
      continue;
    }

    if (isListMarker(line)) {
      const { block, next } = parseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }

    if (isTableStart(lines, i)) {
      const rows = [splitRow(line)];
      for (i += 2; i < lines.length && !isBlank(lines[i]) && lines[i]?.includes("|"); i++) {
        rows.push(splitRow(lines[i] ?? ""));
      }
      const width = Math.max(...rows.map((row) => row.length));
      blocks.push({
        type: "table",
        attrs: { isNumberColumnEnabled: false, layout: "default" },
        content: rows.map((row, rowIndex): AdfBlock => ({
          type: "tableRow",
          content: Array.from({ length: width }, (_, column): AdfBlock => ({
            type: rowIndex === 0 ? "tableHeader" : "tableCell",
            content: [paragraph(parseInline(row[column] ?? ""))],
          })),
        })),
      });
      continue;
    }

    const text = [line];
    for (i++; i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i); i++) {
      text.push(lines[i] ?? "");
    }
    const content = parseInline(text.map((row) => row.trim()).join("\n"));
    if (content.length > 0) blocks.push(paragraph(content));
  }

  return blocks;
}

/**
 * Converts markdown (as agents write it) into an ADF document for Jira Cloud REST v3
 * `description` and comment `body` fields. Never throws; empty input yields an empty doc.
 */
export function markdownToAdf(markdown: string): AdfDoc {
  try {
    return {
      type: "doc",
      version: 1,
      content: parseBlocks(markdown.replace(/\r\n?/g, "\n").split("\n")),
    };
  } catch {
    const content = markdown
      .split(/\n{2,}/)
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => paragraph([textNode(chunk)]));
    return { type: "doc", version: 1, content };
  }
}
