import type { PhrasingContent } from "mdast";
import { describe, expect, it } from "vite-plus/test";

import { parseMarkdown, tableGrid, type TableRow } from "./markdownParse";

const text = (cell: ReadonlyArray<PhrasingContent>): string =>
  cell
    .map((node) => ("value" in node ? node.value : "children" in node ? text(node.children) : ""))
    .join("");
const rowText = (row: TableRow) => row.cells.map((cell) => text(cell.content));

describe("tableGrid", () => {
  it("splits a gfm table into a header and rows of cells", () => {
    const [table] = parseMarkdown(
      "| Tool | Use | Note |\n|---|:-:|---|\n| `api_execute` | **run** | fast |\n| curl | fetch |\n",
    ).children;
    if (table?.type !== "table") throw new Error(`expected a table, got ${table?.type}`);

    const grid = tableGrid(table);

    expect(grid.columns).toBe(3);
    expect(rowText(grid.header)).toEqual(["Tool", "Use", "Note"]);
    expect(grid.rows.map(rowText)).toEqual([
      ["api_execute", "run", "fast"],
      ["curl", "fetch", ""],
    ]);
    expect(grid.rows[0]?.cells[0]?.content[0]?.type).toBe("inlineCode");
  });
});
