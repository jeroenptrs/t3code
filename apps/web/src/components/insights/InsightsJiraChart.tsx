import type { InsightsJira, InsightsOverview } from "@t3tools/contracts";

import { BarRows } from "./charts/BarRows";
import { ChartFrame } from "./charts/ChartFrame";
import { ChartLegend } from "./charts/ChartLegend";
import { chartScale, seriesColor } from "./charts/chartScale";
import { ChartTable } from "./charts/ChartTable";
import { ChartTooltipRow, ChartTooltipTitle } from "./charts/ChartTooltip";
import { SeriesLine } from "./charts/SeriesLine";
import { useChartHover } from "./charts/useChartHover";
import {
  formatInsightsHours,
  formatInsightsHoursOf,
  formatInsightsShare,
  type InsightsJiraSeries,
  insightsJiraSeries,
  insightsJiraTypeLabel,
  insightsUnticketedShare,
  insightsWeekLabel,
} from "./insights.logic";

const SHARE_COLOR = seriesColor(5);

const hoursOf = (
  entries: ReadonlyArray<{ readonly issueType: string; readonly landedHours: number }>,
  line: InsightsJiraSeries,
) =>
  entries.reduce(
    (sum, entry) => (line.types.includes(entry.issueType) ? sum + entry.landedHours : sum),
    0,
  );

function ContributorJira({
  overview,
  jira,
  series,
}: {
  readonly overview: InsightsOverview;
  readonly jira: InsightsJira;
  readonly series: ReadonlyArray<InsightsJiraSeries>;
}) {
  const hover = useChartHover();
  const names = new Map<string, string>(
    overview.contributors.map((row) => [row.contributorId, row.displayName]),
  );
  const rows = jira.byTypeByContributor.map((row) => ({
    key: row.contributorId,
    label: names.get(row.contributorId) ?? row.contributorId,
    hours: series.map((line) => hoursOf(row.hoursByType, line)),
  }));
  const tooltipAt = (index: number) => {
    const row = rows[index]!;
    const total = row.hours.reduce((sum, hours) => sum + hours, 0);
    return (
      <>
        <ChartTooltipTitle>{row.label}</ChartTooltipTitle>
        {series.map((line, lineIndex) => (
          <ChartTooltipRow
            key={line.key}
            color={seriesColor(line.colorIndex)}
            label={line.label}
            value={formatInsightsHoursOf(row.hours[lineIndex]!, total)}
          />
        ))}
      </>
    );
  };
  return (
    <BarRows
      ariaLabel="Share of landed hours by Jira issue type per contributor"
      rows={rows.map((row) => ({
        key: row.key,
        label: row.label,
        segments: series.map((line, lineIndex) => ({
          key: line.key,
          value: row.hours[lineIndex]!,
          color: seriesColor(line.colorIndex),
        })),
      }))}
      max={null}
      hover={hover}
      tooltip={hover.index === null ? null : tooltipAt(hover.index)}
    />
  );
}

function WeeklyUnticketed({ jira }: { readonly jira: InsightsJira }) {
  const hover = useChartHover();
  const weeks = jira.weeks;
  const scale = chartScale(1, 1);
  const tooltipAt = (index: number) => {
    const week = weeks[index]!;
    return (
      <>
        <ChartTooltipTitle>Week of {insightsWeekLabel(week.weekStart)}</ChartTooltipTitle>
        <ChartTooltipRow label="Landed" value={formatInsightsHours(week.landedHours)} />
        <ChartTooltipRow
          color={SHARE_COLOR}
          label="Unticketed"
          value={formatInsightsHoursOf(week.unticketedHours, week.landedHours)}
        />
      </>
    );
  };
  return (
    <ChartFrame
      ariaLabel="Share of the team's landed hours without an issue key per week"
      size="expanded"
      slots={weeks.length}
      scale={scale}
      formatTick={formatInsightsShare}
      xLabels={[
        weeks[0] ? insightsWeekLabel(weeks[0].weekStart) : "",
        weeks.at(-1) ? insightsWeekLabel(weeks.at(-1)!.weekStart) : "",
      ]}
      hover={hover}
      tooltip={hover.index === null ? null : tooltipAt(hover.index)}
    >
      <SeriesLine
        values={weeks.map(insightsUnticketedShare)}
        slots={weeks.length}
        scale={scale}
        color={SHARE_COLOR}
      />
    </ChartFrame>
  );
}

function legendOf(series: ReadonlyArray<InsightsJiraSeries>) {
  return series.map((line) => ({ label: line.label, color: seriesColor(line.colorIndex) }));
}

export function InsightsJiraCard({ overview }: { readonly overview: InsightsOverview }) {
  if (overview.jira === null) return null;
  const series = insightsJiraSeries(overview.jira.byType);
  return (
    <div className="flex flex-col gap-2">
      <ContributorJira overview={overview} jira={overview.jira} series={series} />
      <ChartLegend items={legendOf(series)} />
    </div>
  );
}

export function InsightsJiraExpanded({ overview }: { readonly overview: InsightsOverview }) {
  if (overview.jira === null) return null;
  const jira = overview.jira;
  const series = insightsJiraSeries(jira.byType);
  const landed = jira.byType.reduce((sum, entry) => sum + entry.landedHours, 0);
  return (
    <div className="flex flex-col gap-4">
      <ContributorJira overview={overview} jira={jira} series={series} />
      <ChartLegend items={legendOf(series)} />
      <h3 className="text-sm font-medium">Unticketed share by week</h3>
      <WeeklyUnticketed jira={jira} />
      <ChartTable
        label="Landed hours and commits by issue type"
        columns={["Issue type", "Landed", "Commits"]}
        rows={jira.byType.map((entry) => ({
          key: entry.issueType,
          cells: [
            insightsJiraTypeLabel(entry.issueType),
            formatInsightsHoursOf(entry.landedHours, landed),
            String(entry.commits),
          ],
        }))}
      />
    </div>
  );
}
