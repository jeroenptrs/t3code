import type { InsightsOverview } from "@t3tools/contracts";

import { ChartTable } from "./charts/ChartTable";
import { ChartTooltip, ChartTooltipTitle } from "./charts/ChartTooltip";
import { useChartHover } from "./charts/useChartHover";
import { formatInsightsShare } from "./insights.logic";

/** Four opacity steps of one hue, light enough that the count stays readable on top. */
function cellColor(count: number, max: number): string | undefined {
  if (count === 0 || max === 0) return undefined;
  const step = Math.ceil((count / max) * 4);
  return `color-mix(in oklab, var(--chart-1) ${step * 15}%, transparent)`;
}

function ReviewMatrix({
  overview,
  totals,
}: {
  readonly overview: InsightsOverview;
  readonly totals: boolean;
}) {
  const hover = useChartHover();
  const names = new Map<string, string>(
    overview.contributors.map((row) => [row.contributorId, row.displayName]),
  );
  const cells = new Map(
    overview.reviews.cells.map((cell) => [
      `${cell.reviewerContributorId}\u0000${cell.authorContributorId}`,
      cell,
    ]),
  );
  const order = (ids: Iterable<string>) =>
    [...new Set(ids)].toSorted((left, right) =>
      (names.get(left) ?? left).localeCompare(names.get(right) ?? right),
    );
  const authors = order(overview.reviews.cells.map((cell) => cell.authorContributorId));
  const reviewers = order(overview.reviews.cells.map((cell) => cell.reviewerContributorId));
  const max = Math.max(0, ...overview.reviews.cells.map((cell) => cell.count));
  if (authors.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No included contributor reviewed another's merge request in this window.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto" onPointerLeave={hover.leave}>
      <table aria-label="Reviews given by reviewer and author" className="text-xs tabular-nums">
        <thead>
          <tr>
            <th className="p-1 text-left text-3xs font-normal text-muted-foreground uppercase">
              Reviewer ↓ Author →
            </th>
            {authors.map((author) => (
              <th key={author} scope="col" className="max-w-24 truncate p-1 font-medium">
                {names.get(author) ?? author}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {reviewers.map((reviewer, row) => (
            <tr key={reviewer}>
              <th scope="row" className="max-w-32 truncate p-1 text-left font-medium">
                {names.get(reviewer) ?? reviewer}
              </th>
              {authors.map((author, column) => {
                const cell = cells.get(`${reviewer}\u0000${author}`);
                const index = row * authors.length + column;
                return (
                  <td
                    key={author}
                    data-slot="chart-hit"
                    className="relative h-8 min-w-12 border border-background text-center"
                    style={{ backgroundColor: cellColor(cell?.count ?? 0, max) }}
                    onPointerEnter={() => hover.enter(index)}
                  >
                    {cell?.count ?? ""}
                    {hover.index === index ? (
                      <ChartTooltip x={0.5} y={1}>
                        <ChartTooltipTitle>
                          {names.get(reviewer) ?? reviewer} reviewed {cell?.count ?? 0} of{" "}
                          {names.get(author) ?? author}'s
                        </ChartTooltipTitle>
                        {cell === undefined
                          ? null
                          : cell.mergeRequests.map((number) => `!${number}`).join(", ")}
                      </ChartTooltip>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
          {totals ? (
            <tr>
              <th scope="row" className="p-1 text-left font-medium text-muted-foreground">
                Total
              </th>
              {authors.map((author) => (
                <td key={author} className="h-8 text-center text-muted-foreground">
                  {overview.reviews.cells
                    .filter((cell) => cell.authorContributorId === author)
                    .reduce((sum, cell) => sum + cell.count, 0)}
                </td>
              ))}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

export function InsightsReviewsCard({ overview }: { readonly overview: InsightsOverview }) {
  return <ReviewMatrix overview={overview} totals={false} />;
}

export function InsightsReviewsExpanded({ overview }: { readonly overview: InsightsOverview }) {
  const names = new Map<string, string>(
    overview.contributors.map((row) => [row.contributorId, row.displayName]),
  );
  return (
    <div className="flex flex-col gap-4">
      <ReviewMatrix overview={overview} totals />
      <h3 className="text-sm font-medium">Merged without review</h3>
      <ChartTable
        label="Merged without review by author"
        columns={["Author", "Merged", "Without review", "Share"]}
        rows={overview.reviews.unreviewedMergesByAuthor.map((row) => ({
          key: row.contributorId,
          cells: [
            names.get(row.contributorId) ?? row.contributorId,
            String(row.merged),
            String(row.unreviewed),
            formatInsightsShare(row.merged > 0 ? row.unreviewed / row.merged : null),
          ],
        }))}
      />
    </div>
  );
}
