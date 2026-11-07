import type { ScheduledTaskTimeSchedule, Trigger, TriggerSourceKind } from "@t3tools/contracts";
import { triggerFiltersSummary } from "@t3tools/client-runtime/scheduled-task-trigger";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatScheduledTaskInterval(everyMs: number): string {
  const units = [
    [7 * DAY, "week"],
    [DAY, "day"],
    [HOUR, "hour"],
    [MINUTE, "minute"],
    [1_000, "second"],
    [1, "millisecond"],
  ] as const;
  let remaining = everyMs;
  const parts: string[] = [];
  for (const [size, unit] of units) {
    const count = Math.floor(remaining / size);
    if (count === 0) continue;
    if (count === 1 && remaining === everyMs && remaining === size) return `Every ${unit}`;
    parts.push(`${count} ${unit}${count === 1 ? "" : "s"}`);
    remaining %= size;
  }
  return `Every ${parts.join(" ")}`;
}

function localCalendarDay(date: Date): number {
  // Compare calendar days, not 24-hour spans: DST days can have 23 or 25 hours.
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
}

export function formatNextScheduledTaskRun(nextRunAt: string, now: number): string {
  const next = new Date(nextRunAt);
  const current = new Date(now);
  const remaining = next.getTime() - now;
  if (!Number.isFinite(remaining)) return "Next run unavailable";
  if (remaining <= 0) return "Next run due";

  const days = localCalendarDay(next) - localCalendarDay(current);
  if (days === 0) {
    if (remaining < MINUTE) return "Next run in less than a minute";
    const unit = remaining < HOUR ? "minute" : "hour";
    const count = Math.round(remaining / (remaining < HOUR ? MINUTE : HOUR));
    return `Next run in ${count} ${unit}${count === 1 ? "" : "s"}`;
  }

  const time = next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return `Next run tomorrow at ${time}`;
  if (days <= 7) {
    return `Next run next ${next.toLocaleDateString([], { weekday: "long" })} at ${time}`;
  }
  const date = next.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(next.getFullYear() !== current.getFullYear() ? { year: "numeric" as const } : {}),
  });
  return `Next run ${date} at ${time}`;
}

export const TRIGGER_SOURCE_LABELS = {
  schedule: "Schedule",
  webhook: "Webhook",
  jira: "Jira",
  gitlab: "GitLab",
  slack: "Slack",
  manual: "Manual",
  jira_query: "Jira query",
} as const satisfies Record<TriggerSourceKind, string>;

/** One line per trigger: its source, then what it filters on, such as "Jira · Status equals Done". */
export function formatTriggerSummary(
  trigger: Pick<Trigger, "source" | "filters">,
  formatSchedule: (schedule: ScheduledTaskTimeSchedule) => string,
): string {
  const { source, filters } = trigger;
  if (source.kind === "schedule") return formatSchedule(source.schedule);
  const label = TRIGGER_SOURCE_LABELS[source.kind];
  if (source.kind === "jira_query") {
    const every = `${label} · every ${Math.round(source.everyMs / MINUTE)} minutes`;
    return filters.length === 0
      ? every
      : `${every} · ${triggerFiltersSummary(source.kind, filters)}`;
  }
  if (source.kind === "manual" || filters.length === 0) return label;
  if (source.kind === "webhook") {
    return `${label} · ${filters.length} filter${filters.length === 1 ? "" : "s"}`;
  }
  return `${label} · ${triggerFiltersSummary(source.kind, filters)}`;
}
