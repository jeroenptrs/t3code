import type {
  InsightsContributorKind,
  InsightsContributorRow,
  InsightsOverview,
  InsightsWeek,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isoOf } from "./isoTime.ts";

export interface RollupContributor {
  readonly contributorId: string;
  readonly displayName: string;
  readonly kind: InsightsContributorKind;
}

export interface RollupCommit {
  readonly contributorId: string;
  readonly authoredAt: string;
  readonly landedAt: string | null;
  readonly estimatedHours: number;
  readonly superseded: boolean;
}

export interface RollupMergeRequest {
  readonly authorContributorId: string;
  readonly createdAt: string;
  readonly mergedAt: string | null;
  readonly firstReviewAt: string | null;
  readonly firstCommitAuthoredAt: string | null;
}

export interface RollupReview {
  readonly reviewerContributorId: string;
  /** `project:number`, so several notes on one merge request count as one review. */
  readonly mergeRequestKey: string;
  readonly firstAt: string;
}

export interface RollupInput {
  /** Inclusive UTC days. */
  readonly from: string;
  readonly to: string;
  /** The current UTC day; working days after it have not happened yet. */
  readonly today: string;
  readonly contributors: ReadonlyArray<RollupContributor>;
  readonly commits: ReadonlyArray<RollupCommit>;
  readonly mergeRequests: ReadonlyArray<RollupMergeRequest>;
  readonly reviews: ReadonlyArray<RollupReview>;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const WORKING_HOURS_PER_DAY = 8;

const dayStartMs = (day: string) => Date.parse(`${day}T00:00:00.000Z`);
const dayOf = (ms: number) => isoOf(ms).slice(0, 10);

/** The Monday on or before `day`. */
export function weekStartOf(day: string): string {
  const ms = dayStartMs(day);
  const weekday = (DateTime.getPartUtc(DateTime.makeUnsafe(ms), "weekDay") + 6) % 7;
  return dayOf(ms - weekday * DAY_MS);
}

/** Monday to Friday days from `from` to `to`, both inclusive. */
export function workingDaysBetween(from: string, to: string): number {
  let count = 0;
  for (let ms = dayStartMs(from); ms <= dayStartMs(to); ms += DAY_MS) {
    const weekday = DateTime.getPartUtc(DateTime.makeUnsafe(ms), "weekDay");
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

function median(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const round = (value: number) => Math.round(value * 100) / 100;

export function rollup(input: RollupInput): InsightsOverview {
  const startMs = dayStartMs(input.from);
  const endMs = dayStartMs(input.to) + DAY_MS;
  const inWindow = (iso: string | null): iso is string => {
    if (iso === null) return false;
    const ms = Date.parse(iso);
    return ms >= startMs && ms < endMs;
  };
  const lastWorkingDay = input.to < input.today ? input.to : input.today;
  const workingDays =
    lastWorkingDay < input.from ? 0 : workingDaysBetween(input.from, lastWorkingDay);

  const weeks = new Map<
    string,
    { pushedHours: number; landedHours: number; active: Set<string> }
  >();
  for (let ms = dayStartMs(weekStartOf(input.from)); ms < endMs; ms += 7 * DAY_MS) {
    weeks.set(dayOf(ms), { pushedHours: 0, landedHours: 0, active: new Set() });
  }

  type Totals = {
    pushedHours: number;
    landedHours: number;
    commits: number;
    mergeRequestsMerged: number;
    reviewed: Set<string>;
    firstReviewHours: number[];
    cycleHours: number[];
  };
  const totals = new Map<string, Totals>();
  for (const contributor of input.contributors) {
    totals.set(contributor.contributorId, {
      pushedHours: 0,
      landedHours: 0,
      commits: 0,
      mergeRequestsMerged: 0,
      reviewed: new Set(),
      firstReviewHours: [],
      cycleHours: [],
    });
  }

  for (const commit of input.commits) {
    const total = totals.get(commit.contributorId);
    if (total === undefined || commit.superseded) continue;
    if (inWindow(commit.authoredAt)) {
      total.pushedHours += commit.estimatedHours;
      total.commits += 1;
      const week = weeks.get(weekStartOf(commit.authoredAt.slice(0, 10)));
      if (week !== undefined) {
        week.pushedHours += commit.estimatedHours;
        week.active.add(commit.contributorId);
      }
    }
    if (inWindow(commit.landedAt)) {
      total.landedHours += commit.estimatedHours;
      const week = weeks.get(weekStartOf(commit.landedAt.slice(0, 10)));
      if (week !== undefined) {
        week.landedHours += commit.estimatedHours;
        week.active.add(commit.contributorId);
      }
    }
  }

  for (const mergeRequest of input.mergeRequests) {
    const total = totals.get(mergeRequest.authorContributorId);
    if (total === undefined) continue;
    if (inWindow(mergeRequest.createdAt) && mergeRequest.firstReviewAt !== null) {
      total.firstReviewHours.push(
        Math.max(0, Date.parse(mergeRequest.firstReviewAt) - Date.parse(mergeRequest.createdAt)) /
          HOUR_MS,
      );
    }
    if (inWindow(mergeRequest.mergedAt)) {
      total.mergeRequestsMerged += 1;
      if (mergeRequest.firstCommitAuthoredAt !== null) {
        total.cycleHours.push(
          Math.max(
            0,
            Date.parse(mergeRequest.mergedAt) - Date.parse(mergeRequest.firstCommitAuthoredAt),
          ) / HOUR_MS,
        );
      }
    }
  }

  for (const review of input.reviews) {
    if (inWindow(review.firstAt)) {
      totals.get(review.reviewerContributorId)?.reviewed.add(review.mergeRequestKey);
    }
  }

  const contributors: InsightsContributorRow[] = input.contributors.map((contributor) => {
    const total = totals.get(contributor.contributorId)!;
    const firstReview = median(total.firstReviewHours);
    const cycle = median(total.cycleHours);
    return {
      contributorId: contributor.contributorId as InsightsContributorRow["contributorId"],
      displayName: contributor.displayName,
      kind: contributor.kind,
      pushedHours: round(total.pushedHours),
      landedHours: round(total.landedHours),
      landedShare: total.pushedHours > 0 ? round(total.landedHours / total.pushedHours) : null,
      throughput:
        workingDays > 0 ? round(total.pushedHours / (workingDays * WORKING_HOURS_PER_DAY)) : 0,
      commits: total.commits,
      mergeRequestsMerged: total.mergeRequestsMerged,
      reviewsGiven: total.reviewed.size,
      medianFirstReviewHours: firstReview === null ? null : round(firstReview),
      medianCycleHours: cycle === null ? null : round(cycle),
    };
  });

  const weekRows: InsightsWeek[] = [...weeks].map(([weekStart, week]) => ({
    weekStart,
    pushedHours: round(week.pushedHours),
    landedHours: round(week.landedHours),
    activeContributors: week.active.size,
  }));

  return { from: input.from, to: input.to, workingDays, weeks: weekRows, contributors };
}
