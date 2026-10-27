import type { InsightsOverview } from "@t3tools/contracts";

import { ChartFrame, type ChartSize, StackedColumn } from "./charts/ChartFrame";
import { ChartLegend } from "./charts/ChartLegend";
import { chartScale, seriesColor } from "./charts/chartScale";
import { ChartTable } from "./charts/ChartTable";
import { ChartTooltipRow, ChartTooltipTitle } from "./charts/ChartTooltip";
import { useChartHover } from "./charts/useChartHover";
import { formatInsightsHours, formatInsightsSizeBucket, insightsSeries } from "./insights.logic";

const OTHER = "other";

function SizePlot({
  overview,
  size,
  byAuthor,
}: {
  readonly overview: InsightsOverview;
  readonly size: ChartSize;
  readonly byAuthor: boolean;
}) {
  const hover = useChartHover();
  const buckets = overview.size.buckets;
  const names = new Map<string, string>(
    overview.contributors.map((row) => [row.contributorId, row.displayName]),
  );
  const totals = new Map<string, number>();
  for (const bucket of buckets) {
    for (const entry of bucket.byContributor) {
      totals.set(entry.contributorId, (totals.get(entry.contributorId) ?? 0) + entry.count);
    }
  }
  const { shown, folded } = insightsSeries([...totals].map(([id, total]) => ({ id, total })));
  const series = byAuthor
    ? [
        ...shown.map((id, index) => ({
          key: id,
          label: names.get(id) ?? id,
          color: seriesColor(index),
        })),
        ...(folded.length > 0
          ? [{ key: OTHER, label: "Other", color: seriesColor(shown.length) }]
          : []),
      ]
    : [{ key: "all", label: "Merged", color: seriesColor(0) }];
  const segmentsOf = (index: number) => {
    const bucket = buckets[index]!;
    if (!byAuthor) return [{ key: "all", value: bucket.count, color: seriesColor(0) }];
    const counts = new Map<string, number>(
      bucket.byContributor.map((entry) => [entry.contributorId, entry.count]),
    );
    return series.map((line) => ({
      key: line.key,
      value:
        line.key === OTHER
          ? folded.reduce((sum, id) => sum + (counts.get(id) ?? 0), 0)
          : (counts.get(line.key) ?? 0),
      color: line.color,
    }));
  };
  const scale = chartScale(Math.max(0, ...buckets.map((bucket) => bucket.count)));
  const tooltipAt = (index: number) => {
    const bucket = buckets[index]!;
    return (
      <>
        <ChartTooltipTitle>
          {formatInsightsSizeBucket(bucket)} lines: {bucket.count} merged
        </ChartTooltipTitle>
        <ChartTooltipRow
          label="Median first review"
          value={formatInsightsHours(bucket.medianFirstReviewHours)}
        />
        <ChartTooltipRow
          label="Median files changed"
          value={bucket.medianChangedFiles === null ? "-" : String(bucket.medianChangedFiles)}
        />
        {byAuthor
          ? segmentsOf(index).map((segment, segmentIndex) => (
              <ChartTooltipRow
                key={segment.key}
                color={segment.color}
                label={series[segmentIndex]!.label}
                value={String(segment.value)}
              />
            ))
          : null}
      </>
    );
  };
  return (
    <div className="flex flex-col gap-2">
      <ChartFrame
        ariaLabel="Merged merge requests by lines changed"
        size={size}
        slots={buckets.length}
        scale={scale}
        formatTick={(value) => String(Math.round(value))}
        xLabels={[
          buckets[0] ? `${formatInsightsSizeBucket(buckets[0])} lines` : "",
          buckets.at(-1) ? `${formatInsightsSizeBucket(buckets.at(-1)!)} lines` : "",
        ]}
        hover={hover}
        tooltip={hover.index === null ? null : tooltipAt(hover.index)}
      >
        {buckets.map((bucket, index) => (
          <StackedColumn
            key={bucket.min}
            index={index}
            slots={buckets.length}
            scale={scale}
            segments={segmentsOf(index)}
          />
        ))}
      </ChartFrame>
      {byAuthor ? <ChartLegend items={series} /> : null}
    </div>
  );
}

export function InsightsSizeCard({ overview }: { readonly overview: InsightsOverview }) {
  return <SizePlot overview={overview} size="card" byAuthor={false} />;
}

export function InsightsSizeExpanded({ overview }: { readonly overview: InsightsOverview }) {
  return (
    <div className="flex flex-col gap-4">
      <SizePlot overview={overview} size="expanded" byAuthor />
      <ChartTable
        label="Merge request size"
        columns={["Lines changed", "Merged", "Median first review", "Median files changed"]}
        rows={overview.size.buckets.map((bucket) => ({
          key: String(bucket.min),
          cells: [
            formatInsightsSizeBucket(bucket),
            String(bucket.count),
            formatInsightsHours(bucket.medianFirstReviewHours),
            bucket.medianChangedFiles === null ? "-" : String(bucket.medianChangedFiles),
          ],
        }))}
      />
    </div>
  );
}
