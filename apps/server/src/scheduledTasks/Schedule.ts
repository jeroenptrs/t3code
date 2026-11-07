import {
  MIN_POLL_INTERVAL_MS,
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  type ScheduledTaskSchedule,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const MINUTE_MS = 60_000;

function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

type ClockSchedule = Extract<ScheduledTaskSchedule, { type: "interval" | "fixed_time" | "once" }>;

/** Webhook and event sources run when something raises them; polled sources run on the clock. */
const isClockSchedule = (schedule: ScheduledTaskSchedule): schedule is ClockSchedule =>
  schedule.type === "interval" || schedule.type === "fixed_time" || schedule.type === "once";

type PollSchedule = Extract<ScheduledTaskSchedule, { type: "jira_query" | "gitlab_projects" }>;

/** Sources the scheduled task runner polls instead of running their prompt. */
export const isPollSchedule = <S extends { readonly type: string }>(
  schedule: S,
): schedule is Extract<S, { readonly type: PollSchedule["type"] }> =>
  schedule.type === "jira_query" || schedule.type === "gitlab_projects";

/** What a poll reads. A save that changes it polls at once, and the poll re-seeds silently. */
export function pollScopeKey(schedule: PollSchedule): string {
  return schedule.type === "jira_query"
    ? JSON.stringify([schedule.site, schedule.jql ?? null, schedule.filterId ?? null])
    : JSON.stringify([schedule.host, schedule.projects.toSorted(), schedule.group ?? null]);
}

const filtersKey = (schedule: ScheduledTaskSchedule) =>
  JSON.stringify("filters" in schedule ? (schedule.filters ?? []) : []);

export function nextScheduledRunAt(
  schedule: ScheduledTaskSchedule,
  from: DateTime.DateTime,
): DateTime.DateTime | null {
  if (isPollSchedule(schedule)) {
    return DateTime.addDuration(from, Math.max(schedule.everyMs, MIN_POLL_INTERVAL_MS));
  }
  if (!isClockSchedule(schedule)) return null;
  if (schedule.type === "once") {
    const runAt = DateTime.make(schedule.runAt);
    return Option.isSome(runAt) &&
      DateTime.toEpochMillis(runAt.value) > DateTime.toEpochMillis(from)
      ? runAt.value
      : null;
  }
  if (schedule.type === "interval") {
    // Intervals advance elapsed time, including across daylight-saving changes.
    return DateTime.addDuration(from, Math.max(schedule.everyMs, MIN_SCHEDULED_TASK_INTERVAL_MS));
  }

  const time = parseTimeOfDay(schedule.timeOfDay);
  if (time === null) return null;
  // Wall-clock parts and weekdays are read in the zone `from` carries, so a
  // schedule with its own zone moves `from` there before stepping through days.
  const start =
    schedule.timeZone === undefined
      ? from
      : DateTime.setZone(from, DateTime.zoneMakeNamedUnsafe(schedule.timeZone));
  const weekdays =
    schedule.weekdays && schedule.weekdays.length > 0 ? new Set(schedule.weekdays) : null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = DateTime.setParts(DateTime.add(start, { days: offset }), {
      hour: time.hour,
      minute: time.minute,
      second: 0,
      millisecond: 0,
    });
    if (DateTime.toEpochMillis(candidate) <= DateTime.toEpochMillis(from)) continue;
    if (weekdays !== null && !weekdays.has(DateTime.toParts(candidate).weekDay)) continue;
    return candidate;
  }
  return null;
}

function weekdayKey(weekdays: ReadonlyArray<number> | undefined): string {
  const unique = [...new Set(weekdays ?? [])].toSorted((x, y) => x - y);
  if (unique.length === 0 || unique.length === 7) return "daily";
  return unique.join(",");
}

export function isSameSchedule(a: ScheduledTaskSchedule, b: ScheduledTaskSchedule): boolean {
  if (a.type === "interval") {
    return b.type === "interval" && a.everyMs === b.everyMs;
  }
  if (a.type === "webhook") return b.type === "webhook";
  if (isPollSchedule(a)) {
    return (
      b.type === a.type &&
      pollScopeKey(a) === pollScopeKey(b) &&
      a.everyMs === b.everyMs &&
      filtersKey(a) === filtersKey(b)
    );
  }
  if (!isClockSchedule(a)) return a.type === b.type && filtersKey(a) === filtersKey(b);
  if (a.type === "once") return b.type === "once" && Date.parse(a.runAt) === Date.parse(b.runAt);
  if (b.type !== "fixed_time") return false;
  // Compare parsed times so padded-hour edits do not reschedule pending runs.
  const aTime = parseTimeOfDay(a.timeOfDay);
  const bTime = parseTimeOfDay(b.timeOfDay);
  return (
    aTime !== null &&
    bTime !== null &&
    aTime.hour === bTime.hour &&
    aTime.minute === bTime.minute &&
    a.timeZone === b.timeZone &&
    weekdayKey(a.weekdays) === weekdayKey(b.weekdays)
  );
}

const MISSED_FIXED_TIME_GRACE_MS = 10 * MINUTE_MS;

export function isMissedFixedTimeRun(
  schedule: ScheduledTaskSchedule,
  dueAt: DateTime.DateTime,
  now: DateTime.DateTime,
): boolean {
  if (schedule.type !== "fixed_time") return false;
  return DateTime.toEpochMillis(now) - DateTime.toEpochMillis(dueAt) > MISSED_FIXED_TIME_GRACE_MS;
}
