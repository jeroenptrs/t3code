import { useState } from "react";

/** The hovered slot; it changes only when the pointer crosses into another slot. */
export function useChartHover() {
  const [index, setIndex] = useState<number | null>(null);
  return { index, enter: setIndex, leave: () => setIndex(null) };
}

export type ChartHover = ReturnType<typeof useChartHover>;
