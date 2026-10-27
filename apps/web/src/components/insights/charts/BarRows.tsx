import type { ReactNode } from "react";

import { ChartTooltip } from "./ChartTooltip";
import type { ChartHover } from "./useChartHover";

export interface BarRow {
  readonly key: string;
  readonly label: string;
  readonly segments: ReadonlyArray<{
    readonly key: string;
    readonly value: number;
    readonly color: string;
  }>;
}

/**
 * Horizontal stacked bars, one row per slot. Rows scale to `max`, or each fills the width when
 * `max` is null.
 */
export function BarRows({
  ariaLabel,
  rows,
  max,
  hover,
  tooltip,
}: {
  readonly ariaLabel: string;
  readonly rows: ReadonlyArray<BarRow>;
  readonly max: number | null;
  readonly hover: ChartHover;
  /** The hovered row's numbers; null while nothing is hovered. */
  readonly tooltip: ReactNode;
}) {
  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className="relative flex flex-col gap-1"
      onPointerLeave={hover.leave}
    >
      {rows.map((row, index) => {
        const total = row.segments.reduce((sum, segment) => sum + segment.value, 0);
        const scaleTo = max ?? total;
        const visible = row.segments.filter((segment) => segment.value > 0);
        return (
          <div
            key={row.key}
            data-slot="chart-hit"
            className="flex items-center gap-2 data-[hovered]:bg-muted/60"
            data-hovered={hover.index === index ? "" : undefined}
            onPointerEnter={() => hover.enter(index)}
          >
            <span className="w-24 shrink-0 truncate text-right text-3xs text-muted-foreground uppercase">
              {row.label}
            </span>
            <div className="flex h-3 min-w-0 flex-1 gap-0.5">
              {scaleTo <= 0
                ? null
                : visible.map((segment, segmentIndex) => (
                    <span
                      key={segment.key}
                      className={
                        segmentIndex === visible.length - 1 ? "h-full rounded-e-sm" : "h-full"
                      }
                      style={{
                        width: `${(segment.value / scaleTo) * 100}%`,
                        backgroundColor: segment.color,
                      }}
                    />
                  ))}
            </div>
          </div>
        );
      })}
      {hover.index === null ? null : (
        <ChartTooltip x={0.5} y={(hover.index + 1) / Math.max(1, rows.length)}>
          {tooltip}
        </ChartTooltip>
      )}
    </div>
  );
}
