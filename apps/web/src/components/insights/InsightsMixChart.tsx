import {
  type InsightsByCommitType,
  InsightsCommitTypes,
  type InsightsOverview,
} from "@t3tools/contracts";
import type { ReactNode } from "react";

import { BarRows } from "./charts/BarRows";
import { ChartFrame, StackedColumn } from "./charts/ChartFrame";
import { ChartLegend } from "./charts/ChartLegend";
import { chartScale, seriesColor } from "./charts/chartScale";
import { ChartTable } from "./charts/ChartTable";
import { ChartTooltipRow, ChartTooltipTitle } from "./charts/ChartTooltip";
import { useChartHover } from "./charts/useChartHover";
import {
  formatInsightsHours,
  formatInsightsShare,
  insightsCommitTypeLabel,
  insightsWeekLabel,
} from "./insights.logic";

const LEGEND = InsightsCommitTypes.map((type, index) => ({
  label: insightsCommitTypeLabel(type),
  color: seriesColor(index),
}));

const total = (values: InsightsByCommitType) =>
  InsightsCommitTypes.reduce((sum, type) => sum + values[type], 0);

function mixTooltip(
  title: string,
  hours: InsightsByCommitType,
  commits: InsightsByCommitType,
): ReactNode {
  const sum = total(hours);
  return (
    <>
      <ChartTooltipTitle>{title}</ChartTooltipTitle>
      {InsightsCommitTypes.map((type, index) => (
        <ChartTooltipRow
          key={type}
          color={seriesColor(index)}
          label={insightsCommitTypeLabel(type)}
          value={`${formatInsightsHours(hours[type])} · ${commits[type]} commits · ${formatInsightsShare(sum > 0 ? hours[type] / sum : null)}`}
        />
      ))}
    </>
  );
}

function ContributorMix({ overview }: { readonly overview: InsightsOverview }) {
  const hover = useChartHover();
  const names = new Map<string, string>(
    overview.contributors.map((row) => [row.contributorId, row.displayName]),
  );
  const rows = overview.mix.contributors.map((row) => ({
    ...row,
    label: names.get(row.contributorId) ?? row.contributorId,
  }));
  const tooltipAt = (index: number) => {
    const row = rows[index]!;
    return mixTooltip(row.label, row.hoursByType, row.commitsByType);
  };
  return (
    <BarRows
      ariaLabel="Share of landed hours by commit type per contributor"
      rows={rows.map((row) => ({
        key: row.contributorId,
        label: row.label,
        segments: InsightsCommitTypes.map((type, index) => ({
          key: type,
          value: row.hoursByType[type],
          color: seriesColor(index),
        })),
      }))}
      max={null}
      hover={hover}
      tooltip={hover.index === null ? null : tooltipAt(hover.index)}
    />
  );
}

function WeeklyMix({ overview }: { readonly overview: InsightsOverview }) {
  const hover = useChartHover();
  const weeks = overview.mix.weeks;
  const scale = chartScale(1, 1);
  const tooltipAt = (index: number) => {
    const week = weeks[index]!;
    return mixTooltip(
      `Week of ${insightsWeekLabel(week.weekStart)}`,
      week.hoursByType,
      week.commitsByType,
    );
  };
  return (
    <ChartFrame
      ariaLabel="Share of the team's landed hours by commit type per week"
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
      {weeks.map((week, index) => {
        const sum = total(week.hoursByType);
        return (
          <StackedColumn
            key={week.weekStart}
            index={index}
            slots={weeks.length}
            scale={scale}
            segments={InsightsCommitTypes.map((type, typeIndex) => ({
              key: type,
              value: sum > 0 ? week.hoursByType[type] / sum : 0,
              color: seriesColor(typeIndex),
            }))}
          />
        );
      })}
    </ChartFrame>
  );
}

export function InsightsMixCard({ overview }: { readonly overview: InsightsOverview }) {
  return (
    <div className="flex flex-col gap-2">
      <ContributorMix overview={overview} />
      <ChartLegend items={LEGEND} />
    </div>
  );
}

export function InsightsMixExpanded({ overview }: { readonly overview: InsightsOverview }) {
  const names = new Map<string, string>(
    overview.contributors.map((row) => [row.contributorId, row.displayName]),
  );
  return (
    <div className="flex flex-col gap-4">
      <ContributorMix overview={overview} />
      <ChartLegend items={LEGEND} />
      <h3 className="text-sm font-medium">Team by week</h3>
      <WeeklyMix overview={overview} />
      <ChartTable
        label="Landed hours and commits by type"
        columns={["Contributor", ...InsightsCommitTypes.map(insightsCommitTypeLabel)]}
        rows={overview.mix.contributors.map((row) => ({
          key: row.contributorId,
          cells: [
            names.get(row.contributorId) ?? row.contributorId,
            ...InsightsCommitTypes.map(
              (type) =>
                `${formatInsightsHours(row.hoursByType[type])} (${row.commitsByType[type]})`,
            ),
          ],
        }))}
      />
    </div>
  );
}
