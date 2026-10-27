import type { InsightsWeek } from "@t3tools/contracts";

import { formatInsightsHours, formatInsightsShare } from "./insights.logic";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 220;
const PLOT_TOP = 8;
const TICK_COUNT = 4;

function niceMax(peak: number): number {
  if (peak <= 0) return 1;
  const rawStep = peak / TICK_COUNT;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  return Math.ceil(peak / step) * step;
}

function perContributor(hours: number, active: number): number {
  return active === 0 ? 0 : hours / active;
}

function weekLabel(weekStart: string): string {
  const date = new Date(`${weekStart}T00:00:00Z`);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

const SHARE_TICKS = [0, 0.5, 1];

/**
 * Pushed and landed hours per active contributor for each week, with the landed share to date as
 * a line on its own 0 to 100% axis. The share is cumulative over the window, so it ends at the
 * table's total; a week's own ratio swings past 100% whenever earlier work lands. Static SVG: a
 * hover shows the week's numbers through `<title>`, so nothing repaints while the pointer moves.
 */
export function InsightsTrendChart({ weeks }: { readonly weeks: ReadonlyArray<InsightsWeek> }) {
  const columns = weeks.map((week, index) => {
    const toDate = weeks.slice(0, index + 1);
    const pushedToDate = toDate.reduce((sum, past) => sum + past.pushedHours, 0);
    const landedToDate = toDate.reduce((sum, past) => sum + past.landedHours, 0);
    return {
      week,
      pushed: perContributor(week.pushedHours, week.activeContributors),
      landed: perContributor(week.landedHours, week.activeContributors),
      share: pushedToDate > 0 ? landedToDate / pushedToDate : null,
    };
  });
  const max = niceMax(Math.max(0, ...columns.flatMap((column) => [column.pushed, column.landed])));
  const ticks = Array.from({ length: TICK_COUNT + 1 }, (_, index) => (max / TICK_COUNT) * index);
  const toY = (value: number) => VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP);
  const slot = columns.length === 0 ? VIEW_WIDTH : VIEW_WIDTH / columns.length;
  const barWidth = Math.max(2, slot * 0.32);
  const lastColumn = columns.at(-1);
  // Landed can exceed pushed early in a window; the line stays inside the plot and the hover
  // shows the real value.
  const shareY = (share: number) => VIEW_HEIGHT - Math.min(1, share) * (VIEW_HEIGHT - PLOT_TOP);
  const sharePoints = columns.flatMap((column, index) =>
    column.share === null
      ? []
      : [`${(index * slot + slot / 2).toFixed(2)},${shareY(column.share).toFixed(2)}`],
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <div className="relative h-52 w-12 shrink-0">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
              style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
            >
              {tick === 0 ? "0" : formatInsightsHours(tick)}
            </span>
          ))}
        </div>
        <div className="relative h-52 flex-1">
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="Pushed and landed hours per active contributor by week, with landed share"
          >
            {ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={VIEW_WIDTH}
                y1={toY(tick)}
                y2={toY(tick)}
                stroke="currentColor"
                strokeWidth={1}
                className="text-border"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {columns.map((column, index) => {
              const center = index * slot + slot / 2;
              return (
                <g key={column.week.weekStart}>
                  <title>
                    {`Week of ${weekLabel(column.week.weekStart)}: ${formatInsightsHours(column.pushed)} pushed, ${formatInsightsHours(column.landed)} landed per active contributor (${column.week.activeContributors} active), landed share to date ${formatInsightsShare(column.share)}`}
                  </title>
                  <rect
                    x={index * slot}
                    y={0}
                    width={slot}
                    height={VIEW_HEIGHT}
                    fill="transparent"
                  />
                  <rect
                    x={center - barWidth}
                    y={toY(column.pushed)}
                    width={barWidth}
                    height={VIEW_HEIGHT - toY(column.pushed)}
                    fill="currentColor"
                    className="text-muted-foreground/40"
                  />
                  <rect
                    x={center}
                    y={toY(column.landed)}
                    width={barWidth}
                    height={VIEW_HEIGHT - toY(column.landed)}
                    fill="currentColor"
                    className="text-primary"
                  />
                </g>
              );
            })}
            {sharePoints.length > 1 ? (
              <polyline
                points={sharePoints.join(" ")}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinejoin="round"
                className="text-foreground/70"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>
        </div>
        <div className="relative h-52 w-10 shrink-0">
          {SHARE_TICKS.map((tick) => (
            <span
              key={tick}
              className="absolute left-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
              style={{ top: `${(shareY(tick) / VIEW_HEIGHT) * 100}%` }}
            >
              {formatInsightsShare(tick)}
            </span>
          ))}
        </div>
      </div>
      <div className="flex justify-between pr-12 pl-14 text-3xs text-muted-foreground uppercase">
        <span>{columns[0] ? weekLabel(columns[0].week.weekStart) : ""}</span>
        <span>{lastColumn ? weekLabel(lastColumn.week.weekStart) : ""}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-14 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-muted-foreground/40" />
          Pushed per active contributor
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-primary" />
          Landed per active contributor
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 bg-foreground/70" />
          Landed share to date
        </span>
      </div>
    </div>
  );
}
