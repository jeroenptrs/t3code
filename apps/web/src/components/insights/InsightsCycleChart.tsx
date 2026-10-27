import type { InsightsCycleWeek, InsightsOverview } from "@t3tools/contracts";

import { BarRows } from "./charts/BarRows";
import { ChartLegend } from "./charts/ChartLegend";
import { seriesColor } from "./charts/chartScale";
import { ChartTable } from "./charts/ChartTable";
import { ChartTooltipRow, ChartTooltipTitle } from "./charts/ChartTooltip";
import { useChartHover } from "./charts/useChartHover";
import { formatInsightsSpread, insightsWeekLabel } from "./insights.logic";

type CycleSummary = Omit<InsightsCycleWeek, "weekStart">;

const SEGMENTS = [
  { key: "coding", label: "Coding" },
  { key: "pickup", label: "Pickup" },
  { key: "review", label: "Review" },
  { key: "toTrunk", label: "To trunk" },
] as const satisfies ReadonlyArray<{ readonly key: keyof CycleSummary; readonly label: string }>;

const LEGEND = SEGMENTS.map((segment, index) => ({
  label: segment.label,
  color: seriesColor(index),
}));

function CycleRows({
  ariaLabel,
  rows,
}: {
  readonly ariaLabel: string;
  readonly rows: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly summary: CycleSummary;
  }>;
}) {
  const hover = useChartHover();
  const bars = rows.map((row) => ({
    key: row.key,
    label: row.label,
    segments: SEGMENTS.map((segment, index) => ({
      key: segment.key,
      value: row.summary[segment.key].median ?? 0,
      color: seriesColor(index),
    })),
  }));
  const max = Math.max(
    0,
    ...bars.map((bar) => bar.segments.reduce((sum, segment) => sum + segment.value, 0)),
  );
  const tooltipAt = (index: number) => {
    const row = rows[index]!;
    return (
      <>
        <ChartTooltipTitle>
          {row.label}: {row.summary.count} merged
        </ChartTooltipTitle>
        {SEGMENTS.map((segment, segmentIndex) => (
          <ChartTooltipRow
            key={segment.key}
            color={seriesColor(segmentIndex)}
            label={segment.label}
            value={formatInsightsSpread(row.summary[segment.key])}
          />
        ))}
      </>
    );
  };
  return (
    <BarRows
      ariaLabel={ariaLabel}
      rows={bars}
      max={max}
      hover={hover}
      tooltip={hover.index === null ? null : tooltipAt(hover.index)}
    />
  );
}

const weekRows = (overview: InsightsOverview) =>
  overview.cycle.weeks.map((week) => ({
    key: week.weekStart,
    label: insightsWeekLabel(week.weekStart),
    summary: week,
  }));

export function InsightsCycleCard({ overview }: { readonly overview: InsightsOverview }) {
  return (
    <div className="flex flex-col gap-2">
      <CycleRows ariaLabel="Median cycle time segments by merge week" rows={weekRows(overview)} />
      <ChartLegend items={LEGEND} />
    </div>
  );
}

export function InsightsCycleExpanded({ overview }: { readonly overview: InsightsOverview }) {
  const names = new Map(overview.contributors.map((row) => [row.contributorId, row.displayName]));
  return (
    <div className="flex flex-col gap-4">
      <CycleRows ariaLabel="Median cycle time segments by merge week" rows={weekRows(overview)} />
      <ChartLegend items={LEGEND} />
      <h3 className="text-sm font-medium">By author</h3>
      <CycleRows
        ariaLabel="Median cycle time segments by author"
        rows={overview.cycle.contributors.map((row) => ({
          key: row.contributorId,
          label: names.get(row.contributorId) ?? row.contributorId,
          summary: row,
        }))}
      />
      <ChartTable
        label="Cycle time by week"
        columns={["Week", "Merged", ...SEGMENTS.map((segment) => segment.label)]}
        rows={overview.cycle.weeks.map((week) => ({
          key: week.weekStart,
          cells: [
            insightsWeekLabel(week.weekStart),
            String(week.count),
            ...SEGMENTS.map((segment) => formatInsightsSpread(week[segment.key])),
          ],
        }))}
      />
    </div>
  );
}
