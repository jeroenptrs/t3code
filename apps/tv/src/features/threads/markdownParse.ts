import type { PhrasingContent, Root, Table } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const parser = unified().use(remarkParse).use(remarkGfm);

const PARSE_CACHE_LIMIT = 200;
const parseCache = new Map<string, Root>();

export function parseMarkdown(markdown: string): Root {
  const cached = parseCache.get(markdown);
  if (cached !== undefined) return cached;
  const root = parser.parse(markdown);
  if (parseCache.size >= PARSE_CACHE_LIMIT) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) parseCache.delete(oldest);
  }
  parseCache.set(markdown, root);
  return root;
}

export interface TableCell {
  readonly key: string;
  readonly content: ReadonlyArray<PhrasingContent>;
}

export interface TableRow {
  readonly key: string;
  readonly cells: ReadonlyArray<TableCell>;
}

export interface TableGrid {
  readonly header: TableRow;
  readonly rows: ReadonlyArray<TableRow>;
  readonly columns: number;
}

/**
 * A gfm table as a header and body rows, each padded to the widest row's column count. Keys are
 * source offsets, which hold for as long as the text before them does not change.
 */
export function tableGrid(table: Table): TableGrid {
  const columns = Math.max(0, ...table.children.map((row) => row.children.length));
  const rows = table.children.map((row, rowIndex): TableRow => {
    const rowKey = `r${row.position?.start.offset ?? rowIndex}`;
    return {
      key: rowKey,
      cells: Array.from({ length: columns }, (_, column): TableCell => {
        const cell = row.children[column];
        return {
          key: `${rowKey}.${cell?.position?.start.offset ?? `pad${column}`}`,
          content: cell?.children ?? [],
        };
      }),
    };
  });
  const [header = { key: "header", cells: [] }, ...body] = rows;
  return { header, rows: body, columns };
}
