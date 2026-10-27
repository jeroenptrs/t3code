export interface ChartLegendItem {
  readonly label: string;
  readonly color: string;
  readonly shape?: "box" | "line";
}

export function ChartLegend({ items }: { readonly items: ReadonlyArray<ChartLegendItem> }) {
  if (items.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5">
          <span
            className={item.shape === "line" ? "h-0.5 w-3" : "size-2.5 rounded-sm"}
            style={{ backgroundColor: item.color }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}
