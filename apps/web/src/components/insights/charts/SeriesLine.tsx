import { type ChartScale, presentRuns, VIEW_WIDTH } from "./chartScale";

/** A line through one value per slot, broken where a slot has none. */
export function SeriesLine({
  values,
  slots,
  scale,
  color,
}: {
  readonly values: ReadonlyArray<number | null>;
  readonly slots: number;
  readonly scale: ChartScale;
  readonly color: string;
}) {
  const slot = VIEW_WIDTH / Math.max(1, slots);
  const x = (index: number) => index * slot + slot / 2;
  return presentRuns(values).map((run) =>
    run.length === 1 ? (
      <line
        key={run[0]}
        x1={x(run[0]!) - slot * 0.15}
        x2={x(run[0]!) + slot * 0.15}
        y1={scale.y(values[run[0]!]!)}
        y2={scale.y(values[run[0]!]!)}
        stroke={color}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    ) : (
      <polyline
        key={run[0]}
        points={run.map((index) => `${x(index)},${scale.y(values[index]!)}`).join(" ")}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    ),
  );
}
