import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { CheckIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxListVirtualized,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import { SelectButton } from "../ui/select";

const SERVER_TIME_ZONE_VALUE = "__server__";

/**
 * Picks the IANA zone a fixed-time schedule is read in. An empty `timeZone`
 * means the task follows the server's local zone.
 */
export function ScheduledTaskTimeZonePicker({
  timeZone,
  onSelect,
}: {
  timeZone: string;
  onSelect: (timeZone: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listRef = useRef<LegendListRef | null>(null);

  const zones = useMemo(() => {
    const supported = Intl.supportedValuesOf("timeZone");
    // The engine's list omits aliases such as UTC, so a saved zone may be missing.
    return timeZone.length === 0 || supported.includes(timeZone)
      ? supported
      : [timeZone, ...supported];
  }, [timeZone]);

  const items = useMemo(() => {
    const trimmedQuery = query.trim().toLowerCase().replaceAll(" ", "_");
    if (trimmedQuery.length === 0) return [SERVER_TIME_ZONE_VALUE, ...zones];
    return zones.filter((zone) => zone.toLowerCase().includes(trimmedQuery));
  }, [query, zones]);

  const selectedValue = timeZone.length === 0 ? SERVER_TIME_ZONE_VALUE : timeZone;
  const label = (value: string) =>
    value === SERVER_TIME_ZONE_VALUE ? "Server time" : value.replaceAll("_", " ");

  return (
    <Combobox
      items={items}
      filteredItems={items}
      autoHighlight
      virtualized
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setQuery("");
      }}
      value={selectedValue}
      onValueChange={(next) => {
        if (typeof next !== "string") return;
        setOpen(false);
        onSelect(next === SERVER_TIME_ZONE_VALUE ? "" : next);
      }}
      onItemHighlighted={(_value, eventDetails) => {
        // Keyboard highlights must pull the virtualized row into view, or
        // arrow keys walk past the rendered window and navigate blind.
        if (!open || eventDetails.index < 0 || eventDetails.reason !== "keyboard") return;
        void listRef.current?.scrollIndexIntoView?.({ index: eventDetails.index, animated: false });
      }}
    >
      <ComboboxTrigger aria-label="Time zone" render={<SelectButton size="sm" />}>
        {label(selectedValue)}
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="flex w-72 flex-col">
        <ComboboxSearchInput
          placeholder="Search time zones…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ComboboxEmpty>No time zones found.</ComboboxEmpty>
          <div className="relative min-h-0 max-h-72 w-full flex-1 overflow-hidden">
            <ComboboxListVirtualized>
              <LegendList<string>
                ref={listRef}
                data={items}
                keyExtractor={(item) => item}
                renderItem={({ item, index }) => (
                  <ComboboxItem hideIndicator index={index} key={item} value={item}>
                    <div className="flex w-full min-w-0 items-center justify-between gap-2">
                      <span className="min-w-0 truncate">{label(item)}</span>
                      {item === selectedValue ? (
                        <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : null}
                    </div>
                  </ComboboxItem>
                )}
                estimatedItemSize={30}
                drawDistance={360}
                style={{ height: Math.min(items.length * 30, 288) }}
              />
            </ComboboxListVirtualized>
          </div>
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}
