import type { List, ListItem, PhrasingContent, Root, RootContent, Table } from "mdast";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { colors, typography } from "../../components/theme";
import { parseMarkdown, tableGrid, type TableRow } from "./markdownParse";

// A markdown-lite renderer for the TV: paragraphs, headings, emphasis, inline and fenced code,
// lists, task lists, tables, quotes, and links and footnotes as plain text. Plain React Native views, no native module. A
// top-level image becomes its own block so the caller can render it as a focusable thumbnail.

function renderInline(nodes: ReadonlyArray<PhrasingContent>, keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}.${index}`;
    switch (node.type) {
      case "text":
        return node.value;
      case "strong":
        return (
          <Text key={key} style={styles.strong}>
            {renderInline(node.children, key)}
          </Text>
        );
      case "emphasis":
        return (
          <Text key={key} style={styles.emphasis}>
            {renderInline(node.children, key)}
          </Text>
        );
      case "delete":
        return (
          <Text key={key} style={styles.delete}>
            {renderInline(node.children, key)}
          </Text>
        );
      case "inlineCode":
        return (
          <Text key={key} style={styles.inlineCode}>
            {node.value}
          </Text>
        );
      case "link":
      case "linkReference":
        // Nothing on a TV opens a link, so it reads as its text.
        return (
          <Text key={key} style={styles.link}>
            {renderInline(node.children, key)}
          </Text>
        );
      case "image":
      case "imageReference":
        return node.alt ? `[${node.alt}]` : "";
      case "footnoteReference":
        return `[${node.label ?? node.identifier}]`;
      case "break":
        return "\n";
      case "html":
        return node.value;
      default:
        return "";
    }
  });
}

function plainText(node: RootContent | Root): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node) return (node.children as RootContent[]).map(plainText).join("");
  return "";
}

const HEADING_STYLES = [
  typography.heading1,
  typography.heading2,
  typography.heading3,
  typography.heading3,
  typography.heading3,
  typography.heading3,
] as const;

function renderListItemContent(item: ListItem, key: string): ReactNode[] {
  return item.children.map((child, index) => renderBlock(child, `${key}.${index}`, true));
}

function renderList(list: List, key: string, nested: boolean): ReactNode {
  const start = list.start ?? 1;
  return (
    <View key={key} style={[styles.list, nested && styles.nestedList]}>
      {list.children.map((item, index) => {
        // Source offsets identify an item for as long as the text before it does not change.
        const itemKey = `${key}.${item.position?.start.offset ?? ""}`;
        return (
          <ListItemView
            key={itemKey}
            marker={list.ordered ? `${start + index}.` : "•"}
            checked={item.checked ?? null}
          >
            {renderListItemContent(item, itemKey)}
          </ListItemView>
        );
      })}
    </View>
  );
}

function ListItemView(props: {
  readonly marker: string;
  readonly checked: boolean | null;
  readonly children: ReactNode;
}) {
  return (
    <View style={styles.listItem}>
      <Text style={styles.listMarker}>
        {props.checked === null ? props.marker : props.checked ? "☑" : "☐"}
      </Text>
      <View style={styles.listItemBody}>{props.children}</View>
    </View>
  );
}

function renderTableRow(row: TableRow, key: string, header: boolean): ReactNode {
  return (
    <View
      key={row.key}
      style={[styles.tableRow, header ? styles.tableHeader : styles.tableBodyRow]}
    >
      {row.cells.map((cell) => (
        <View key={cell.key} style={styles.tableCell}>
          <Text style={[styles.tableText, header && styles.strong]}>
            {renderInline(cell.content, `${key}.${cell.key}`)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function renderTable(table: Table, key: string): ReactNode {
  const { header, rows } = tableGrid(table);
  return (
    <View key={key} style={styles.table}>
      {renderTableRow(header, key, true)}
      {rows.map((row) => renderTableRow(row, key, false))}
    </View>
  );
}

function renderBlock(node: RootContent, key: string, nested = false): ReactNode {
  switch (node.type) {
    case "paragraph":
      return (
        <Text key={key} style={styles.paragraph}>
          {renderInline(node.children, key)}
        </Text>
      );
    case "heading":
      return (
        <Text key={key} style={[styles.heading, HEADING_STYLES[node.depth - 1]]}>
          {renderInline(node.children, key)}
        </Text>
      );
    case "code":
      return (
        <View key={key} style={styles.codeBlock}>
          {node.lang ? <Text style={styles.codeLang}>{node.lang}</Text> : null}
          <Text style={styles.codeText}>{node.value}</Text>
        </View>
      );
    case "list":
      return renderList(node, key, nested);
    case "blockquote":
      return (
        <View key={key} style={styles.blockquote}>
          {node.children.map((child, index) => renderBlock(child, `${key}.${index}`, true))}
        </View>
      );
    case "table":
      return renderTable(node, key);
    case "footnoteDefinition":
      return (
        <View key={key} style={styles.footnote}>
          <Text style={styles.listMarker}>[{node.label ?? node.identifier}]</Text>
          <View style={styles.listItemBody}>
            {node.children.map((child, index) => renderBlock(child, `${key}.${index}`, true))}
          </View>
        </View>
      );
    case "thematicBreak":
      return <View key={key} style={styles.rule} />;
    case "html":
      return (
        <Text key={key} style={styles.paragraph}>
          {node.value}
        </Text>
      );
    default: {
      const text = plainText(node);
      return text ? (
        <Text key={key} style={styles.paragraph}>
          {text}
        </Text>
      ) : null;
    }
  }
}

export type MarkdownBlock =
  | { readonly kind: "element"; readonly key: string; readonly element: ReactNode }
  | { readonly kind: "image"; readonly key: string; readonly href: string; readonly alt: string };

function isBlankText(node: PhrasingContent): boolean {
  return (node.type === "text" && node.value.trim() === "") || node.type === "break";
}

/** A paragraph's images split out as image blocks, with the text runs between them kept. */
function splitParagraphImages(nodes: ReadonlyArray<PhrasingContent>, key: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let run: PhrasingContent[] = [];
  const flush = () => {
    if (run.some((node) => !isBlankText(node))) {
      const runKey = `${key}.t${blocks.length}`;
      blocks.push({
        kind: "element",
        key: runKey,
        element: <Text style={styles.paragraph}>{renderInline(run, runKey)}</Text>,
      });
    }
    run = [];
  };
  for (const node of nodes) {
    if (node.type === "image") {
      flush();
      blocks.push({
        kind: "image",
        key: `${key}.i${blocks.length}`,
        href: node.url,
        alt: node.alt ?? "",
      });
    } else {
      run.push(node);
    }
  }
  flush();
  return blocks;
}

/**
 * The top-level blocks of `markdown`, each a separate element so the caller can make each one
 * a focus stop. A top-level list yields one block per item, so a long list scrolls item by item.
 */
export function renderMarkdownBlocks(markdown: string): ReadonlyArray<MarkdownBlock> {
  const root = parseMarkdown(markdown);
  const blocks: Array<MarkdownBlock> = [];
  root.children.forEach((node, index) => {
    const key = `b${index}`;
    if (node.type === "paragraph" && node.children.some((child) => child.type === "image")) {
      blocks.push(...splitParagraphImages(node.children, key));
      return;
    }
    if (node.type === "list") {
      const start = node.start ?? 1;
      node.children.forEach((item, itemIndex) => {
        const itemKey = `${key}.${itemIndex}`;
        blocks.push({
          kind: "element",
          key: itemKey,
          element: (
            <ListItemView
              marker={node.ordered ? `${start + itemIndex}.` : "•"}
              checked={item.checked ?? null}
            >
              {renderListItemContent(item, itemKey)}
            </ListItemView>
          ),
        });
      });
      return;
    }
    const element = renderBlock(node, key);
    if (element !== null) blocks.push({ kind: "element", key, element });
  });
  return blocks;
}

const styles = StyleSheet.create({
  paragraph: { color: colors.text, ...typography.body },
  heading: { color: colors.text, fontWeight: "700", marginTop: 8 },
  strong: { fontWeight: "700" },
  emphasis: { fontStyle: "italic" },
  delete: { textDecorationLine: "line-through" },
  link: { color: "#a5a5ff" },
  inlineCode: {
    fontFamily: typography.monospaceFamily,
    fontSize: typography.code.fontSize,
    color: "#e6c07b",
    backgroundColor: colors.surface,
  },
  codeBlock: {
    backgroundColor: "#111118",
    borderColor: colors.surfaceFocused,
    borderWidth: 2,
    borderRadius: 12,
    paddingHorizontal: 28,
    paddingVertical: 20,
    gap: 6,
  },
  codeLang: { color: colors.textMuted, ...typography.small },
  codeText: {
    color: colors.text,
    fontFamily: typography.monospaceFamily,
    ...typography.code,
  },
  list: { gap: 6 },
  nestedList: { marginTop: 6 },
  listItem: { flexDirection: "row", gap: 16 },
  listMarker: { color: colors.textMuted, minWidth: 36, ...typography.body },
  listItemBody: { flex: 1, gap: 8 },
  blockquote: {
    borderLeftWidth: 4,
    borderLeftColor: colors.textMuted,
    paddingLeft: 20,
    gap: 8,
  },
  table: {
    borderColor: colors.inputBorder,
    borderWidth: 2,
    borderRadius: 12,
    overflow: "hidden",
  },
  tableRow: { flexDirection: "row" },
  tableHeader: { backgroundColor: colors.surface },
  tableBodyRow: { borderTopWidth: 2, borderTopColor: colors.inputBorder },
  tableCell: { flex: 1, flexBasis: 0, paddingHorizontal: 20, paddingVertical: 12 },
  tableText: { color: colors.text, ...typography.code },
  footnote: { flexDirection: "row", gap: 16 },
  rule: { height: 2, backgroundColor: colors.surfaceFocused, marginVertical: 8 },
});
