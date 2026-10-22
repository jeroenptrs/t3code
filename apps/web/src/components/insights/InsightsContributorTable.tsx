import type { InsightsContributorRow } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import {
  formatInsightsHours,
  formatInsightsMultiple,
  formatInsightsShare,
  INSIGHTS_DEFAULT_SORT,
  nextInsightsSort,
  sortInsightsRows,
  type InsightsSort,
  type InsightsSortKey,
} from "./insights.logic";

const COLUMNS: ReadonlyArray<{
  readonly key: InsightsSortKey;
  readonly label: string;
  readonly format: (row: InsightsContributorRow) => string;
}> = [
  { key: "displayName", label: "Name", format: (row) => row.displayName },
  { key: "landedHours", label: "Landed", format: (row) => formatInsightsHours(row.landedHours) },
  { key: "pushedHours", label: "Pushed", format: (row) => formatInsightsHours(row.pushedHours) },
  {
    key: "landedShare",
    label: "Landed share",
    format: (row) => formatInsightsShare(row.landedShare),
  },
  {
    key: "throughput",
    label: "Throughput",
    format: (row) => formatInsightsMultiple(row.throughput),
  },
  { key: "commits", label: "Commits", format: (row) => String(row.commits) },
  {
    key: "mergeRequestsMerged",
    label: "MRs merged",
    format: (row) => String(row.mergeRequestsMerged),
  },
  { key: "reviewsGiven", label: "Reviews given", format: (row) => String(row.reviewsGiven) },
  {
    key: "medianFirstReviewHours",
    label: "Median first review",
    format: (row) => formatInsightsHours(row.medianFirstReviewHours),
  },
  {
    key: "medianCycleHours",
    label: "Median cycle time",
    format: (row) => formatInsightsHours(row.medianCycleHours),
  },
];

export function InsightsContributorTable({
  rows,
}: {
  readonly rows: ReadonlyArray<InsightsContributorRow>;
}) {
  const [sort, setSort] = useState<InsightsSort>(INSIGHTS_DEFAULT_SORT);
  const sorted = sortInsightsRows(rows, sort);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {COLUMNS.map((column) => {
            const active = sort.key === column.key;
            return (
              <TableHead
                key={column.key}
                scope="col"
                aria-sort={
                  active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"
                }
              >
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setSort((current) => nextInsightsSort(current, column.key))}
                >
                  {column.label}
                  {active ? sort.direction === "asc" ? <ArrowUpIcon /> : <ArrowDownIcon /> : null}
                </Button>
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((row) => (
          <TableRow key={row.contributorId}>
            {COLUMNS.map((column) => (
              <TableCell key={column.key}>
                {column.key === "displayName" ? (
                  <span className="flex items-center gap-1.5 font-medium">
                    {row.displayName}
                    {row.kind === "human" ? null : (
                      <Badge size="sm" variant="outline">
                        {row.kind === "agent" ? "Agent" : "Bot"}
                      </Badge>
                    )}
                  </span>
                ) : (
                  <span className="tabular-nums">{column.format(row)}</span>
                )}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
