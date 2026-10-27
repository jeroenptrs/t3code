import type { ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { type ChartScale, VIEW_HEIGHT, VIEW_WIDTH } from "./chartScale";
import { ChartTooltip } from "./ChartTooltip";
import type { ChartHover } from "./useChartHover";

export type ChartSize = "card" | "expanded";

/**
 * Axes, gridlines and one hit rect per slot around a chart's SVG marks, drawn in a
 * `VIEW_WIDTH` by `VIEW_HEIGHT` box. The tooltip sits over the hovered slot.
 */
export function ChartFrame({
  ariaLabel,
  size,
  slots,
  scale,
  formatTick,
  rightTicks,
  xLabels,
  hover,
  tooltip,
  children,
}: {
  readonly ariaLabel: string;
  readonly size: ChartSize;
  readonly slots: number;
  readonly scale: ChartScale;
  readonly formatTick: (value: number) => string;
  /** Labels on a right axis, `y` in SVG units. */
  readonly rightTicks?: ReadonlyArray<{ readonly label: string; readonly y: number }>;
  readonly xLabels: readonly [string, string];
  readonly hover: ChartHover;
  /** The hovered slot's numbers; null while nothing is hovered. */
  readonly tooltip: ReactNode;
  readonly children: ReactNode;
}) {
  const height = size === "card" ? "h-40" : "h-72";
  const slot = slots === 0 ? VIEW_WIDTH : VIEW_WIDTH / slots;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <div className={cn("relative w-12 shrink-0", height)}>
          {scale.ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
              style={{ top: `${(scale.y(tick) / VIEW_HEIGHT) * 100}%` }}
            >
              {tick === 0 ? "0" : formatTick(tick)}
            </span>
          ))}
        </div>
        <div className={cn("relative flex-1", height)} onPointerLeave={hover.leave}>
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={ariaLabel}
          >
            {scale.ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={VIEW_WIDTH}
                y1={scale.y(tick)}
                y2={scale.y(tick)}
                stroke="currentColor"
                strokeWidth={1}
                className="text-border"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {hover.index === null ? null : (
              <rect
                x={hover.index * slot}
                y={0}
                width={slot}
                height={VIEW_HEIGHT}
                fill="currentColor"
                className="text-muted/60"
              />
            )}
            {children}
            {Array.from({ length: slots }, (_, index) => (
              <rect
                key={index}
                data-slot="chart-hit"
                x={index * slot}
                y={0}
                width={slot}
                height={VIEW_HEIGHT}
                fill="transparent"
                onPointerEnter={() => hover.enter(index)}
              />
            ))}
          </svg>
          {hover.index === null ? null : (
            <ChartTooltip x={(hover.index + 0.5) / Math.max(1, slots)} y={0}>
              {tooltip}
            </ChartTooltip>
          )}
        </div>
        {rightTicks === undefined ? null : (
          <div className={cn("relative w-10 shrink-0", height)}>
            {rightTicks.map((tick) => (
              <span
                key={tick.label}
                className="absolute left-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
                style={{ top: `${(tick.y / VIEW_HEIGHT) * 100}%` }}
              >
                {tick.label}
              </span>
            ))}
          </div>
        )}
      </div>
      <div
        className={cn(
          "flex justify-between pl-14 text-3xs text-muted-foreground uppercase",
          rightTicks === undefined ? "pr-0" : "pr-12",
        )}
      >
        <span>{xLabels[0]}</span>
        <span>{xLabels[1]}</span>
      </div>
    </div>
  );
}

/** Stacked segments of one slot, bottom up, with a 2px surface gap between them. */
export function StackedColumn({
  index,
  slots,
  scale,
  segments,
  widthShare = 0.6,
}: {
  readonly index: number;
  readonly slots: number;
  readonly scale: ChartScale;
  readonly segments: ReadonlyArray<{
    readonly key: string;
    readonly value: number;
    readonly color: string;
  }>;
  readonly widthShare?: number;
}) {
  const slot = VIEW_WIDTH / Math.max(1, slots);
  const width = Math.max(2, slot * widthShare);
  const x = index * slot + (slot - width) / 2;
  const placed = [];
  let base = 0;
  for (const segment of segments) {
    if (segment.value <= 0) continue;
    placed.push({ ...segment, top: scale.y(base + segment.value), bottom: scale.y(base) });
    base += segment.value;
  }
  return (
    <g>
      {placed.map((segment) => (
        <rect
          key={segment.key}
          x={x}
          y={segment.top}
          width={width}
          height={Math.max(0, segment.bottom - segment.top)}
          fill={segment.color}
          stroke="var(--background)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  );
}
