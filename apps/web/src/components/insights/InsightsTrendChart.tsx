import type { InsightsOverview, InsightsWeek } from "@t3tools/contracts";
import { useState } from "react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ChartFrame, type ChartSize } from "./charts/ChartFrame";
import { ChartLegend } from "./charts/ChartLegend";
import { chartScale, VIEW_HEIGHT, VIEW_WIDTH } from "./charts/chartScale";
import { ChartTable } from "./charts/ChartTable";
import { ChartTooltipRow, ChartTooltipTitle } from "./charts/ChartTooltip";
import { useChartHover } from "./charts/useChartHover";
import { formatInsightsHours, formatInsightsShare, insightsWeekLabel } from "./insights.logic";

const PUSHED_COLOR = "color-mix(in oklab, var(--muted-foreground) 40%, transparent)";
const LANDED_COLOR = "var(--chart-1)";
const SHARE_COLOR = "color-mix(in oklab, var(--foreground) 70%, transparent)";
const SHARE_TICKS = [0, 0.5, 1];

function trendColumns(weeks: ReadonlyArray<InsightsWeek>) {
  let pushedToDate = 0;
  let landedToDate = 0;
  return weeks.map((week) => {
    pushedToDate += week.pushedHours;
    landedToDate += week.landedHours;
    const active = week.activeContributors;
    return {
      week,
      pushed: active === 0 ? 0 : week.pushedHours / active,
      landed: active === 0 ? 0 : week.landedHours / active,
      share: pushedToDate > 0 ? landedToDate / pushedToDate : null,
    };
  });
}

/**
 * Pushed and landed hours per active contributor for each week, with the landed share to date as
 * a line on its own 0 to 100% axis. The share is cumulative over the window, so it ends at the
 * table's total; a week's own ratio swings past 100% whenever earlier work lands.
 */
function InsightsTrendChart({
  weeks,
  size,
}: {
  readonly weeks: ReadonlyArray<InsightsWeek>;
  readonly size: ChartSize;
}) {
  const hover = useChartHover();
  const columns = trendColumns(weeks);
  const scale = chartScale(
    Math.max(0, ...columns.flatMap((column) => [column.pushed, column.landed])),
  );
  const slot = columns.length === 0 ? VIEW_WIDTH : VIEW_WIDTH / columns.length;
  const barWidth = Math.max(2, slot * 0.32);
  // Landed can exceed pushed early in a window; the line stays inside the plot and the tooltip
  // shows the real value.
  const shareY = (share: number) => VIEW_HEIGHT - Math.min(1, share) * (VIEW_HEIGHT - 8);
  const sharePoints = columns.flatMap((column, index) =>
    column.share === null
      ? []
      : [`${(index * slot + slot / 2).toFixed(2)},${shareY(column.share).toFixed(2)}`],
  );

  const tooltipAt = (index: number) => {
    const column = columns[index]!;
    return (
      <>
        <ChartTooltipTitle>Week of {insightsWeekLabel(column.week.weekStart)}</ChartTooltipTitle>
        <ChartTooltipRow
          color={PUSHED_COLOR}
          label="Pushed"
          value={formatInsightsHours(column.pushed)}
        />
        <ChartTooltipRow
          color={LANDED_COLOR}
          label="Landed"
          value={formatInsightsHours(column.landed)}
        />
        <ChartTooltipRow label="Active" value={String(column.week.activeContributors)} />
        <ChartTooltipRow label="Landed share to date" value={formatInsightsShare(column.share)} />
      </>
    );
  };
  return (
    <div className="flex flex-col gap-2">
      <ChartFrame
        ariaLabel="Pushed and landed hours per active contributor by week, with landed share"
        size={size}
        slots={columns.length}
        scale={scale}
        formatTick={formatInsightsHours}
        rightTicks={SHARE_TICKS.map((tick) => ({
          label: formatInsightsShare(tick),
          y: shareY(tick),
        }))}
        xLabels={[
          columns[0] ? insightsWeekLabel(columns[0].week.weekStart) : "",
          columns.at(-1) ? insightsWeekLabel(columns.at(-1)!.week.weekStart) : "",
        ]}
        hover={hover}
        tooltip={hover.index === null ? null : tooltipAt(hover.index)}
      >
        {columns.map((column, index) => {
          const center = index * slot + slot / 2;
          return (
            <g key={column.week.weekStart}>
              <rect
                x={center - barWidth - 1}
                y={scale.y(column.pushed)}
                width={barWidth}
                height={VIEW_HEIGHT - scale.y(column.pushed)}
                fill={PUSHED_COLOR}
              />
              <rect
                x={center + 1}
                y={scale.y(column.landed)}
                width={barWidth}
                height={VIEW_HEIGHT - scale.y(column.landed)}
                fill={LANDED_COLOR}
              />
            </g>
          );
        })}
        {sharePoints.length > 1 ? (
          <polyline
            points={sharePoints.join(" ")}
            fill="none"
            stroke={SHARE_COLOR}
            strokeWidth={2}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </ChartFrame>
      <ChartLegend
        items={[
          { label: "Pushed per active contributor", color: PUSHED_COLOR },
          { label: "Landed per active contributor", color: LANDED_COLOR },
          { label: "Landed share to date", color: SHARE_COLOR, shape: "line" },
        ]}
      />
    </div>
  );
}

/** One contributor's weeks in the shape of the team's, so the same chart draws either. */
function contributorWeeks(overview: InsightsOverview, contributorId: string): InsightsWeek[] {
  const rows = new Map(
    overview.byContributorWeeks
      .filter((row) => row.contributorId === contributorId)
      .map((row) => [row.weekStart, row]),
  );
  return overview.weeks.map((week) => {
    const row = rows.get(week.weekStart);
    return {
      weekStart: week.weekStart,
      pushedHours: row?.pushedHours ?? 0,
      landedHours: row?.landedHours ?? 0,
      activeContributors: row === undefined ? 0 : 1,
    };
  });
}

const TEAM = "team";

export function InsightsTrendExpanded({ overview }: { readonly overview: InsightsOverview }) {
  const [series, setSeries] = useState(TEAM);
  const active = overview.contributors.filter(
    (contributor) => contributor.pushedHours > 0 || contributor.landedHours > 0,
  );
  const selected = active.some((contributor) => contributor.contributorId === series)
    ? series
    : TEAM;
  const weeks = selected === TEAM ? overview.weeks : contributorWeeks(overview, selected);
  const columns = trendColumns(weeks);
  return (
    <div className="flex flex-col gap-4">
      {active.length > 1 ? (
        <Select
          value={selected}
          onValueChange={(value) => setSeries(value ?? TEAM)}
          items={[
            { value: TEAM, label: "Team" },
            ...active.map((contributor) => ({
              value: contributor.contributorId as string,
              label: contributor.displayName,
            })),
          ]}
        >
          <div className="w-56">
            <SelectTrigger size="sm" aria-label="Trend series">
              <SelectValue />
            </SelectTrigger>
          </div>
          <SelectPopup>
            <SelectItem value={TEAM}>Team</SelectItem>
            {active.map((contributor) => (
              <SelectItem key={contributor.contributorId} value={contributor.contributorId}>
                {contributor.displayName}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
      <InsightsTrendChart weeks={weeks} size="expanded" />
      <ChartTable
        label="Weekly trend"
        columns={[
          "Week",
          "Pushed",
          "Landed",
          "Active",
          "Pushed per active",
          "Landed per active",
          "Landed share to date",
        ]}
        rows={columns.map((column) => ({
          key: column.week.weekStart,
          cells: [
            insightsWeekLabel(column.week.weekStart),
            formatInsightsHours(column.week.pushedHours),
            formatInsightsHours(column.week.landedHours),
            String(column.week.activeContributors),
            formatInsightsHours(column.pushed),
            formatInsightsHours(column.landed),
            formatInsightsShare(column.share),
          ],
        }))}
      />
    </div>
  );
}

export function InsightsTrendCard({ overview }: { readonly overview: InsightsOverview }) {
  return <InsightsTrendChart weeks={overview.weeks} size="card" />;
}
