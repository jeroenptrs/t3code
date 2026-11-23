import {
  parseFactoryId,
  type ScheduledTaskTimeSchedule,
  type Trigger,
  type TriggerSourceKind,
} from "@t3tools/contracts";
import { triggerFiltersSummary } from "@t3tools/client-runtime/scheduled-task-trigger";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const INTERVAL_UNITS = [
  [7 * DAY, msg("Every week"), msg("{count, plural, one {{count} week} other {{count} weeks}}")],
  [DAY, msg("Every day"), msg("{count, plural, one {{count} day} other {{count} days}}")],
  [HOUR, msg("Every hour"), msg("{count, plural, one {{count} hour} other {{count} hours}}")],
  [
    MINUTE,
    msg("Every minute"),
    msg("{count, plural, one {{count} minute} other {{count} minutes}}"),
  ],
  [
    1_000,
    msg("Every second"),
    msg("{count, plural, one {{count} second} other {{count} seconds}}"),
  ],
  [
    1,
    msg("Every millisecond"),
    msg("{count, plural, one {{count} millisecond} other {{count} milliseconds}}"),
  ],
] as const;

export function formatScheduledTaskInterval(everyMs: number, resolve: MessageResolver = m): string {
  let remaining = everyMs;
  const parts: string[] = [];
  for (const [size, every, amount] of INTERVAL_UNITS) {
    const count = Math.floor(remaining / size);
    if (count === 0) continue;
    if (count === 1 && remaining === everyMs && remaining === size) return resolve(every);
    parts.push(resolve(amount, { count }));
    remaining %= size;
  }
  return resolve(msg("Every {duration}", { duration: parts.join(" ") }));
}

function localCalendarDay(date: Date): number {
  // Compare calendar days, not 24-hour spans: DST days can have 23 or 25 hours.
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
}

const WEEKDAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

export function formatNextScheduledTaskRun(
  nextRunAt: string,
  now: number,
  resolve: MessageResolver = m,
): string {
  const next = new Date(nextRunAt);
  const current = new Date(now);
  const remaining = next.getTime() - now;
  if (!Number.isFinite(remaining)) return resolve(msg("Next run unavailable"));
  if (remaining <= 0) return resolve(msg("Next run due"));

  const days = localCalendarDay(next) - localCalendarDay(current);
  if (days === 0) {
    if (remaining < MINUTE) return resolve(msg("Next run in less than a minute"));
    const minutes = Math.round(remaining / MINUTE);
    if (minutes < 60) {
      return resolve(
        msg(
          "{count, plural, one {Next run in {count} minute} other {Next run in {count} minutes}}",
          { count: minutes },
        ),
      );
    }
    return resolve(
      msg("{count, plural, one {Next run in {count} hour} other {Next run in {count} hours}}", {
        count: Math.round(remaining / HOUR),
      }),
    );
  }

  const time = next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return resolve(msg("Next run tomorrow at {time}", { time }));
  if (days <= 7) {
    return resolve(
      msg(
        "{day, select, sunday {Next run next Sunday at {time}} monday {Next run next Monday at {time}} tuesday {Next run next Tuesday at {time}} wednesday {Next run next Wednesday at {time}} thursday {Next run next Thursday at {time}} friday {Next run next Friday at {time}} other {Next run next Saturday at {time}}}",
        { day: WEEKDAY_KEYS[next.getDay()] ?? "saturday", time },
      ),
    );
  }
  const date = next.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(next.getFullYear() !== current.getFullYear() ? { year: "numeric" as const } : {}),
  });
  return resolve(msg("Next run {date} at {time}", { date, time }));
}

export const TRIGGER_SOURCE_LABELS = {
  schedule: "Schedule",
  webhook: "Webhook",
  jira: "Jira",
  gitlab: "GitLab",
  slack: "Slack",
  manual: "Manual",
  jira_query: "Jira query",
  gitlab_projects: "GitLab projects",
  issues: "Issues",
  pull_requests: "Pull requests",
} as const satisfies Record<TriggerSourceKind, string>;

/**
 * One line per trigger: its source, then what it filters on, such as "Jira · Status equals Done",
 * and the factory a work item trigger feeds.
 */
export function formatTriggerSummary(
  trigger: Pick<Trigger, "source" | "filters"> & { readonly target?: Trigger["target"] },
  formatSchedule: (schedule: ScheduledTaskTimeSchedule) => string,
): string {
  const summary = formatTriggerSource(trigger, formatSchedule);
  const { target } = trigger;
  if (target?.type !== "work_item") return summary;
  return `${summary} → ${parseFactoryId(target.factoryId)?.name ?? target.factoryId}`;
}

function formatTriggerSource(
  trigger: Pick<Trigger, "source" | "filters">,
  formatSchedule: (schedule: ScheduledTaskTimeSchedule) => string,
): string {
  const { source, filters } = trigger;
  if (source.kind === "schedule") return formatSchedule(source.schedule);
  const label = TRIGGER_SOURCE_LABELS[source.kind];
  if (
    source.kind === "jira_query" ||
    source.kind === "gitlab_projects" ||
    source.kind === "issues" ||
    source.kind === "pull_requests"
  ) {
    const parts: Array<string> = [label];
    if ((source.kind === "issues" || source.kind === "pull_requests") && source.query) {
      parts.push(`"${source.query}"`);
    }
    if (source.kind === "gitlab_projects") {
      const count = source.projects.length;
      if (count > 0) parts.push(`${count} project${count === 1 ? "" : "s"}`);
      if (source.group !== undefined) parts.push(`group ${source.group}`);
    }
    parts.push(`every ${Math.round(source.everyMs / MINUTE)} minutes`);
    parts.push(triggerFiltersSummary(source.kind, filters));
    return parts.filter((part) => part !== "").join(" · ");
  }
  if (source.kind === "manual" || filters.length === 0) return label;
  if (source.kind === "webhook") {
    return `${label} · ${filters.length} filter${filters.length === 1 ? "" : "s"}`;
  }
  return [label, triggerFiltersSummary(source.kind, filters)]
    .filter((part) => part !== "")
    .join(" · ");
}
