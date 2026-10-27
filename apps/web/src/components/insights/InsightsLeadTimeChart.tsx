import type { InsightsLeadTimeWeek, InsightsOverview } from "@t3tools/contracts";

import { ChartFrame, type ChartSize } from "./charts/ChartFrame";
import { ChartLegend } from "./charts/ChartLegend";
import { chartScale, presentRuns, seriesColor, VIEW_WIDTH } from "./charts/chartScale";
import { ChartTable } from "./charts/ChartTable";
import { ChartTooltipRow, ChartTooltipTitle } from "./charts/ChartTooltip";
import { SeriesLine } from "./charts/SeriesLine";
import { useChartHover } from "./charts/useChartHover";
import { formatInsightsDays, insightsSeries, insightsWeekLabel } from "./insights.logic";

const BAND_COLOR = "color-mix(in oklab, var(--chart-1) 18%, transparent)";

interface LineSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly weeks: ReadonlyArray<InsightsLeadTimeWeek>;
}

function LeadTimePlot({
  series,
  band,
  size,
}: {
  readonly series: ReadonlyArray<LineSeries>;
  /** Draws the team's 85th percentile as a band above its median. */
  readonly band: boolean;
  readonly size: ChartSize;
}) {
  const hover = useChartHover();
  const weeks = series[0]?.weeks ?? [];
  const slots = weeks.length;
  const scale = chartScale(
    Math.max(
      0,
      ...series.flatMap((line) =>
        line.weeks.map((week) => (band ? week.p85Days : week.medianDays) ?? 0),
      ),
    ),
  );
  const slot = VIEW_WIDTH / Math.max(1, slots);
  const x = (index: number) => index * slot + slot / 2;
  const team = series[0];
  const tooltipAt = (index: number) => (
    <>
      <ChartTooltipTitle>Week of {insightsWeekLabel(weeks[index]!.weekStart)}</ChartTooltipTitle>
      {series.map((line) => {
        const week = line.weeks[index]!;
        return (
          <ChartTooltipRow
            key={line.key}
            color={line.color}
            label={`${line.label} (${week.count})`}
            value={
              band
                ? `${formatInsightsDays(week.medianDays)} median, ${formatInsightsDays(week.p85Days)} p85`
                : formatInsightsDays(week.medianDays)
            }
          />
        );
      })}
    </>
  );
  return (
    <ChartFrame
      ariaLabel="Median days from first commit to landed by merge week"
      size={size}
      slots={slots}
      scale={scale}
      formatTick={formatInsightsDays}
      xLabels={[
        weeks[0] ? insightsWeekLabel(weeks[0].weekStart) : "",
        weeks.at(-1) ? insightsWeekLabel(weeks.at(-1)!.weekStart) : "",
      ]}
      hover={hover}
      tooltip={hover.index === null ? null : tooltipAt(hover.index)}
    >
      {band && team !== undefined
        ? presentRuns(team.weeks.map((week) => week.p85Days)).map((run) => (
            <polygon
              key={run[0]}
              points={[
                ...run.map((index) => `${x(index)},${scale.y(team.weeks[index]!.p85Days!)}`),
                ...run
                  .toReversed()
                  .map((index) => `${x(index)},${scale.y(team.weeks[index]!.medianDays!)}`),
              ].join(" ")}
              fill={BAND_COLOR}
            />
          ))
        : null}
      {series.map((line) => (
        <SeriesLine
          key={line.key}
          values={line.weeks.map((week) => week.medianDays)}
          slots={slots}
          scale={scale}
          color={line.color}
        />
      ))}
    </ChartFrame>
  );
}

const teamSeries = (overview: InsightsOverview): LineSeries => ({
  key: "team",
  label: "Team",
  color: seriesColor(0),
  weeks: overview.leadTime.weeks,
});

export function InsightsLeadTimeCard({ overview }: { readonly overview: InsightsOverview }) {
  return <LeadTimePlot series={[teamSeries(overview)]} band size="card" />;
}

export function InsightsLeadTimeExpanded({ overview }: { readonly overview: InsightsOverview }) {
  const names = new Map<string, string>(
    overview.contributors.map((row) => [row.contributorId, row.displayName]),
  );
  const byId = new Map<string, InsightsOverview["leadTime"]["contributors"][number]>(
    overview.leadTime.contributors.map((row) => [row.contributorId, row]),
  );
  const { shown, folded } = insightsSeries(
    overview.leadTime.contributors.map((row) => ({
      id: row.contributorId,
      total: row.weeks.reduce((sum, week) => sum + week.count, 0),
    })),
  );
  const authors: LineSeries[] = shown.map((id, index) => ({
    key: id,
    label: names.get(id) ?? id,
    color: seriesColor(index),
    weeks: byId.get(id)!.weeks,
  }));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <LeadTimePlot series={[teamSeries(overview)]} band size="expanded" />
        <ChartLegend
          items={[
            { label: "Median", color: seriesColor(0), shape: "line" },
            { label: "Median to 85th percentile", color: BAND_COLOR },
          ]}
        />
      </div>
      {authors.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">By author</h3>
          <LeadTimePlot series={authors} band={false} size="expanded" />
          <ChartLegend
            items={authors.map((line) => ({ label: line.label, color: line.color, shape: "line" }))}
          />
          {folded.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              The {shown.length} authors with the most measured merges; {folded.length} more are in
              the team line.
            </p>
          ) : null}
        </div>
      ) : null}
      <ChartTable
        label="Lead time by week"
        columns={["Week", "Median", "85th percentile", "Merged and landed"]}
        rows={overview.leadTime.weeks.map((week) => ({
          key: week.weekStart,
          cells: [
            insightsWeekLabel(week.weekStart),
            formatInsightsDays(week.medianDays),
            formatInsightsDays(week.p85Days),
            String(week.count),
          ],
        }))}
      />
    </div>
  );
}
