import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";

describe("scheduled task schedule calculation", () => {
  it("skips to the next matching fixed-time weekday", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("reads fixed times in the schedule's own time zone", () => {
    const schedule = {
      type: "fixed_time",
      timeOfDay: "09:00",
      timeZone: "Europe/Amsterdam",
      weekdays: [1],
    } as const;
    const utcIso = (from: string) => {
      const next = nextScheduledRunAt(schedule, DateTime.makeUnsafe(from));
      return next ? DateTime.formatIso(DateTime.toUtc(next)) : null;
    };
    // Sunday 23:30 UTC is already Monday in Amsterdam (CEST, UTC+2).
    expect(utcIso("2026-07-05T23:30:00.000Z")).toBe("2026-07-06T07:00:00.000Z");
    // After the autumn DST change the same wall-clock time is UTC+1.
    expect(utcIso("2026-10-24T12:00:00.000Z")).toBe("2026-10-26T08:00:00.000Z");
  });

  it("treats a time zone change as a schedule change", () => {
    const fixedTime = { type: "fixed_time", timeOfDay: "09:00" } as const;
    expect(isSameSchedule(fixedTime, { ...fixedTime, timeZone: "Europe/Amsterdam" })).toBe(false);
    expect(
      isSameSchedule(
        { ...fixedTime, timeZone: "Europe/Amsterdam" },
        { ...fixedTime, timeZone: "Europe/Amsterdam" },
      ),
    ).toBe(true);
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 }),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:30" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
  });
});
