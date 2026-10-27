import type { ReactNode } from "react";

/** One tooltip for a chart, placed at fractions of its positioned parent. */
export function ChartTooltip({
  x,
  y,
  children,
}: {
  readonly x: number;
  readonly y: number;
  readonly children: ReactNode;
}) {
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 w-max max-w-64 -translate-x-1/2 rounded-md border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-md"
      style={{ left: `${Math.min(0.85, Math.max(0.15, x)) * 100}%`, top: `${y * 100}%` }}
    >
      {children}
    </div>
  );
}

export function ChartTooltipTitle({ children }: { readonly children: ReactNode }) {
  return <div className="mb-0.5 font-medium">{children}</div>;
}

export function ChartTooltipRow({
  color,
  label,
  value,
}: {
  readonly color?: string;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="flex items-center gap-1.5 tabular-nums">
      {color === undefined ? null : (
        <span className="size-2 shrink-0 rounded-sm" style={{ backgroundColor: color }} />
      )}
      <span className="text-muted-foreground">{label}</span>
      <span className="ms-auto ps-3">{value}</span>
    </div>
  );
}
