export const VIEW_WIDTH = 960;
export const VIEW_HEIGHT = 220;
const PLOT_TOP = 8;
const TICK_COUNT = 4;

/** Fixed order; a chart never draws more than six series. */
const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
] as const;

export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length]!;
}

function niceMax(peak: number): number {
  if (peak <= 0) return 1;
  const rawStep = peak / TICK_COUNT;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  return Math.ceil(peak / step) * step;
}

export interface ChartScale {
  readonly max: number;
  readonly ticks: ReadonlyArray<number>;
  /** SVG y of a value, clamped to the plot. */
  readonly y: (value: number) => number;
}

export function chartScale(peak: number, fixedMax?: number): ChartScale {
  const max = fixedMax ?? niceMax(peak);
  return {
    max,
    ticks: Array.from({ length: TICK_COUNT + 1 }, (_, index) => (max / TICK_COUNT) * index),
    y: (value) =>
      VIEW_HEIGHT - (Math.min(max, Math.max(0, value)) / max) * (VIEW_HEIGHT - PLOT_TOP),
  };
}

/** Index runs where a value exists, so a line breaks over weeks without one. */
export function presentRuns(
  values: ReadonlyArray<number | null>,
): ReadonlyArray<ReadonlyArray<number>> {
  const runs: number[][] = [];
  let current: number[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) runs.push(current);
      current = [];
    } else {
      current.push(index);
    }
  });
  if (current.length > 0) runs.push(current);
  return runs;
}
