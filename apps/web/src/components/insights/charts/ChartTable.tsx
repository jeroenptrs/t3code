import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../ui/table";

/** The numbers a chart shows, as the readable and accessible fallback under the expanded view. */
export function ChartTable({
  label,
  columns,
  rows,
}: {
  readonly label: string;
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<{ readonly key: string; readonly cells: ReadonlyArray<string> }>;
}) {
  return (
    <div className="tabular-nums">
      <Table aria-label={label}>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column}>{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              {row.cells.map((cell, index) => (
                <TableCell key={columns[index] ?? index}>{cell}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
