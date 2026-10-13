interface AdfNode {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly attrs?: Record<string, unknown>;
  readonly marks?: ReadonlyArray<unknown>;
  readonly content?: ReadonlyArray<unknown>;
}

const INLINE_TYPES = new Set([
  "text",
  "hardBreak",
  "mention",
  "emoji",
  "inlineCard",
  "date",
  "status",
  "mediaInline",
  "placeholder",
  "inlineExtension",
]);

const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList", "decisionList"]);

const PANEL_LABELS: Record<string, string> = {
  info: "Info",
  note: "Note",
  warning: "Warning",
  error: "Error",
  success: "Success",
};

const asNode = (value: unknown): AdfNode | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as AdfNode) : null;

const childrenOf = (node: AdfNode): AdfNode[] =>
  Array.isArray(node.content) ? node.content.flatMap((child) => asNode(child) ?? []) : [];

const attrString = (node: AdfNode, key: string): string | undefined => {
  const value = node.attrs?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const indent = (text: string, prefix: string) =>
  text
    .split("\n")
    .map((line) => (line ? prefix + line : line))
    .join("\n");

const quote = (text: string) =>
  text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");

/** Longest backtick run in `text` plus one, so the fence cannot be closed by the content. */
const fenceFor = (text: string, min: number) =>
  "`".repeat(Math.max(min, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)));

/** Wraps `text` in `mark`, keeping edge whitespace outside so emphasis still renders. */
function wrap(text: string, open: string, close = open) {
  const [, lead = "", inner = "", trail = ""] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) ?? [];
  return inner ? `${lead}${open}${inner}${close}${trail}` : text;
}

function renderText(node: AdfNode): string {
  let out = typeof node.text === "string" ? node.text : "";
  const marks = (node.marks ?? []).flatMap((mark) => asNode(mark) ?? []);
  const has = (type: string) => marks.some((mark) => mark.type === type);
  if (has("code")) {
    const fence = fenceFor(out, 1);
    out = wrap(
      out,
      fence + (out.startsWith("`") ? " " : ""),
      (out.endsWith("`") ? " " : "") + fence,
    );
  }
  if (has("em")) out = wrap(out, "*");
  if (has("strong")) out = wrap(out, "**");
  if (has("strike")) out = wrap(out, "~~");
  const href = marks.find((mark) => mark.type === "link")?.attrs?.href;
  if (typeof href === "string" && href) {
    const safe = href.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
    out = `[${out}](${safe})`;
  }
  return out;
}

const urlOf = (node: AdfNode) => {
  const data = node.attrs?.data;
  const dataUrl = typeof data === "object" && data !== null && "url" in data ? data.url : undefined;
  const url = attrString(node, "url") ?? (typeof dataUrl === "string" ? dataUrl : undefined);
  return url ? `<${url}>` : "";
};

const mediaText = (node: AdfNode) => attrString(node, "alt") ?? "[attachment]";

function renderDate(node: AdfNode): string {
  const ms = Number(node.attrs?.timestamp);
  // @effect-diagnostics-next-line globalDate:off
  const date = new Date(ms);
  return Number.isFinite(ms) && !Number.isNaN(date.getTime())
    ? date.toISOString().slice(0, 10)
    : "";
}

function renderInline(node: AdfNode): string {
  switch (node.type) {
    case "text":
      return renderText(node);
    case "hardBreak":
      return "  \n";
    case "mention": {
      const text = attrString(node, "text");
      return text ? (text.startsWith("@") ? text : `@${text}`) : "@user";
    }
    case "emoji":
      return attrString(node, "text") ?? attrString(node, "shortName") ?? "";
    case "inlineCard":
      return urlOf(node);
    case "date":
      return renderDate(node);
    case "status": {
      const text = attrString(node, "text");
      return text ? `\`${text}\`` : "";
    }
    case "mediaInline":
      return mediaText(node);
    case "placeholder":
      return "";
    default:
      return renderInlineRun(childrenOf(node));
  }
}

const renderInlineRun = (nodes: ReadonlyArray<AdfNode>) => nodes.map(renderInline).join("");

/** Keeps text from turning into a heading, quote, or list when a line starts with its syntax. */
const escapeLineStart = (line: string) =>
  /^\s*(#{1,6}\s|>|[-+*]\s)/.test(line)
    ? line.replace(/^(\s*)/, "$1\\")
    : line.replace(/^(\s*\d+)([.)])(?=\s)/, "$1\\$2");

/** Rendered block children, with runs of stray inline nodes grouped into one paragraph. */
function renderParts(nodes: ReadonlyArray<AdfNode>): Array<{ text: string; isList: boolean }> {
  const parts: Array<{ text: string; isList: boolean }> = [];
  let run: AdfNode[] = [];
  const flush = () => {
    if (run.length > 0) parts.push({ text: renderInlineRun(run).trim(), isList: false });
    run = [];
  };
  for (const node of nodes) {
    if (typeof node.type === "string" && INLINE_TYPES.has(node.type)) {
      run.push(node);
    } else {
      flush();
      parts.push({ text: renderBlock(node), isList: LIST_TYPES.has(String(node.type)) });
    }
  }
  flush();
  return parts.filter((part) => part.text.trim());
}

const renderBlocks = (nodes: ReadonlyArray<AdfNode>) =>
  renderParts(nodes)
    .map((part) => part.text)
    .join("\n\n");

/** One list entry: its first block follows the marker, nested blocks align under it. */
function renderItem(marker: string, node: AdfNode): string {
  // Nested lists attach with a single newline so the list stays tight.
  const body = renderParts(childrenOf(node)).reduce(
    (acc, part, i) => (i === 0 ? part.text : `${acc}${part.isList ? "\n" : "\n\n"}${part.text}`),
    "",
  );
  return marker + indent(body, " ".repeat(marker.length)).trimStart();
}

function renderList(node: AdfNode, markerFor: (item: AdfNode, index: number) => string): string {
  const items: string[] = [];
  let index = 0;
  for (const child of childrenOf(node)) {
    if (child.type === "taskList" && items.length > 0) {
      // Newer ADF nests a task list directly inside the previous task list.
      items[items.length - 1] += `\n${indent(renderBlock(child), "  ")}`;
    } else {
      items.push(renderItem(markerFor(child, index++), child));
    }
  }
  return items.join("\n");
}

const taskMarker = (item: AdfNode) => (item.attrs?.state === "DONE" ? "- [x] " : "- [ ] ");

function renderCell(cell: AdfNode): string {
  return renderBlocks(childrenOf(cell))
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function renderTable(node: AdfNode): string {
  const rows = childrenOf(node).map((row) => childrenOf(row).map(renderCell));
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (width === 0) return "";
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  const [header = [], ...body] = rows;
  return [line(header), line(Array.from({ length: width }, () => "---")), ...body.map(line)].join(
    "\n",
  );
}

function renderBlock(node: AdfNode): string {
  const kids = childrenOf(node);
  switch (node.type) {
    case "doc":
      return renderBlocks(kids);
    case "paragraph":
      return renderInlineRun(kids).trim().split("\n").map(escapeLineStart).join("\n");
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
      const text = renderInlineRun(kids)
        .replace(/\s*\n\s*/g, " ")
        .trim();
      return text ? `${"#".repeat(level)} ${text}` : "";
    }
    case "bulletList":
    case "decisionList":
      return renderList(node, () => "- ");
    case "orderedList": {
      const start = Number(node.attrs?.order);
      const first = Number.isInteger(start) && start >= 0 ? start : 1;
      return renderList(node, (_, index) => `${first + index}. `);
    }
    case "taskList":
      return renderList(node, taskMarker);
    case "listItem":
    case "taskItem":
    case "decisionItem":
      return renderBlocks(kids);
    case "codeBlock": {
      const code = kids.map((kid) => (typeof kid.text === "string" ? kid.text : "")).join("");
      const fence = fenceFor(code, 3);
      return `${fence}${attrString(node, "language") ?? ""}\n${code.replace(/\n$/, "")}\n${fence}`;
    }
    case "blockquote": {
      const body = renderBlocks(kids);
      return body ? quote(body) : "";
    }
    case "rule":
      return "---";
    case "panel": {
      const label = PANEL_LABELS[attrString(node, "panelType") ?? ""];
      const body = renderBlocks(kids);
      const text = label ? (body ? `**${label}:**\n\n${body}` : `**${label}:**`) : body;
      return text ? quote(text) : "";
    }
    case "table":
      return renderTable(node);
    case "expand":
    case "nestedExpand": {
      const title = attrString(node, "title");
      return [title ? `**${title}**` : "", renderBlocks(kids)].filter(Boolean).join("\n\n");
    }
    case "mediaSingle":
    case "mediaGroup":
      return kids
        .map((kid) => (kid.type === "media" ? mediaText(kid) : renderBlocks([kid])))
        .filter(Boolean)
        .join("\n\n");
    case "media":
      return mediaText(node);
    case "blockCard":
    case "embedCard":
      return urlOf(node);
    case "caption":
      return renderInlineRun(kids).trim();
    default:
      return renderBlocks(kids);
  }
}

/** Converts an Atlassian Document Format document (unknown JSON from Jira's REST v3) to markdown. Returns "" for null/invalid input. Never throws. */
export function adfToMarkdown(doc: unknown): string {
  const node = asNode(doc);
  if (!node) return "";
  try {
    return renderBlock(node).trim();
  } catch {
    return "";
  }
}
