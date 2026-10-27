import {
  INSIGHTS_JIRA_UNKNOWN,
  INSIGHTS_JIRA_UNTICKETED,
  type InsightsByCommitType,
  type InsightsCommitType,
  InsightsCommitTypes,
  type InsightsContributorId,
  type InsightsContributorKind,
  type InsightsContributorRow,
  type InsightsContributorWeek,
  type InsightsCycle,
  type InsightsCycleWeek,
  type InsightsHeadline,
  type InsightsJira,
  type InsightsLeadTime,
  type InsightsLeadTimeWeek,
  type InsightsMix,
  type InsightsOverview,
  type InsightsReviews,
  type InsightsSizeBucket,
  type InsightsSpread,
  type InsightsWeek,
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
  /** `project:number` of the merge request the commit came from, when one did. */
  readonly mergeRequestKey: string | null;
  readonly messageSubject: string;
  readonly hasAgentCoauthor: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly jiraKeys: ReadonlyArray<string>;
}

export interface RollupJiraIssue {
  readonly key: string;
  /** Null when Jira did not return the issue to the reader. */
  readonly issueType: string | null;
  readonly parentKey: string | null;
}

export interface RollupMergeRequest {
  readonly authorContributorId: string;
  /** `project:number`. */
  readonly mergeRequestKey: string;
  readonly number: number;
  readonly state: string;
  readonly createdAt: string;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly firstReviewAt: string | null;
  readonly firstCommitAuthoredAt: string | null;
  readonly changedFiles: number | null;
}

export interface RollupReview {
  readonly reviewerContributorId: string;
  /** `project:number`, so several notes on one merge request count as one review. */
  readonly mergeRequestKey: string;
  readonly mergeRequestNumber: number;
  /** Null when the merge request's author is not an included contributor. */
  readonly authorContributorId: string | null;
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
  /** Cached issue rows for the keys the commits carry, on the reader's site. */
  readonly jiraIssues: ReadonlyArray<RollupJiraIssue>;
  readonly jiraConfigured: boolean;
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

/** Linear interpolation between the closest ranks, so `quantile(values, 0.5)` is the median. */
export function quantile(values: ReadonlyArray<number>, q: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

const median = (values: ReadonlyArray<number>) => quantile(values, 0.5);

const asId = (id: string) => id as InsightsContributorId;
const round = (value: number) => Math.round(value * 100) / 100;
const roundOrNull = (value: number | null) => (value === null ? null : round(value));

function spread(values: ReadonlyArray<number>): InsightsSpread {
  return { median: roundOrNull(median(values)), p85: roundOrNull(quantile(values, 0.85)) };
}

const hoursBetween = (from: string, to: string) =>
  Math.max(0, Date.parse(to) - Date.parse(from)) / HOUR_MS;

const COMMIT_SUBJECT_TYPE = /^(\w+)(\(.*\))?!?:/;

/** The conventional commit type of a subject; anything outside the tracked types is `other`. */
export function commitTypeOf(subject: string): InsightsCommitType {
  const type = COMMIT_SUBJECT_TYPE.exec(subject)?.[1]?.toLowerCase();
  return InsightsCommitTypes.find((known) => known === type) ?? "other";
}

/** Lines added plus deleted, inclusive bounds; the last bucket is open-ended. */
const SIZE_BUCKETS: ReadonlyArray<{ readonly min: number; readonly max: number | null }> = [
  { min: 0, max: 49 },
  { min: 50, max: 200 },
  { min: 201, max: 500 },
  { min: 501, max: 1000 },
  { min: 1001, max: null },
];

export function sizeBucketIndex(lines: number): number {
  return SIZE_BUCKETS.findIndex((bucket) => bucket.max === null || lines <= bucket.max);
}

/** A review that came after the merge did not gate it. */
const reviewedBeforeMerge = (mergeRequest: RollupMergeRequest, mergedAt: string) =>
  mergeRequest.firstReviewAt !== null && mergeRequest.firstReviewAt <= mergedAt;

interface CycleSegments {
  readonly coding: number | null;
  readonly pickup: number;
  readonly review: number | null;
  readonly toTrunk: number | null;
}

/** Hours per segment of a merged merge request; without a review, pickup runs to the merge. */
export function cycleSegmentsOf(
  mergeRequest: RollupMergeRequest,
  mergedAt: string,
  landedAt: string | null,
): CycleSegments {
  const reviewed = reviewedBeforeMerge(mergeRequest, mergedAt);
  return {
    coding:
      mergeRequest.firstCommitAuthoredAt === null
        ? null
        : hoursBetween(mergeRequest.firstCommitAuthoredAt, mergeRequest.createdAt),
    pickup: hoursBetween(mergeRequest.createdAt, reviewed ? mergeRequest.firstReviewAt! : mergedAt),
    review: reviewed ? hoursBetween(mergeRequest.firstReviewAt!, mergedAt) : null,
    toTrunk: landedAt === null ? null : hoursBetween(mergedAt, landedAt),
  };
}

const emptyByType = (): Record<InsightsCommitType, number> => ({
  feat: 0,
  fix: 0,
  chore: 0,
  docs: 0,
  test: 0,
  other: 0,
});

const roundByType = (values: Record<InsightsCommitType, number>): InsightsByCommitType => ({
  feat: round(values.feat),
  fix: round(values.fix),
  chore: round(values.chore),
  docs: round(values.docs),
  test: round(values.test),
  other: round(values.other),
});

const groupBy = <A>(items: ReadonlyArray<A>, key: (item: A) => string) => {
  const groups = new Map<string, A[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group === undefined) groups.set(key(item), [item]);
    else group.push(item);
  }
  return groups;
};

/** A merge request merged inside the window, with what its stored commits say about it. */
interface MergedRequest {
  readonly mergeRequest: RollupMergeRequest;
  readonly mergedAt: string;
  readonly weekStart: string;
  /** The earliest landing of its commits; null until one lands inside the window. */
  readonly landedAt: string | null;
  /** Null when none of its commits are in the window's rows. */
  readonly lines: number | null;
}

function cycleSection(
  merged: ReadonlyArray<MergedRequest>,
  weekStarts: ReadonlyArray<string>,
  contributorIds: ReadonlyArray<string>,
): InsightsCycle {
  const summarize = (requests: ReadonlyArray<MergedRequest>) => {
    const segments = requests.map((request) =>
      cycleSegmentsOf(request.mergeRequest, request.mergedAt, request.landedAt),
    );
    const present = (pick: (segment: CycleSegments) => number | null) =>
      segments.flatMap((segment) => {
        const value = pick(segment);
        return value === null ? [] : [value];
      });
    return {
      count: requests.length,
      coding: spread(present((segment) => segment.coding)),
      pickup: spread(present((segment) => segment.pickup)),
      review: spread(present((segment) => segment.review)),
      toTrunk: spread(present((segment) => segment.toTrunk)),
    };
  };
  const byWeek = groupBy(merged, (request) => request.weekStart);
  const byAuthor = groupBy(merged, (request) => request.mergeRequest.authorContributorId);
  return {
    weeks: weekStarts.map((weekStart): InsightsCycleWeek => ({
      weekStart,
      ...summarize(byWeek.get(weekStart) ?? []),
    })),
    contributors: contributorIds.flatMap((contributorId) => {
      const requests = byAuthor.get(contributorId);
      return requests === undefined
        ? []
        : [{ contributorId: asId(contributorId), ...summarize(requests) }];
    }),
  };
}

const leadTimeDays = (request: MergedRequest) =>
  request.landedAt === null || request.mergeRequest.firstCommitAuthoredAt === null
    ? null
    : hoursBetween(request.mergeRequest.firstCommitAuthoredAt, request.landedAt) / 24;

function leadTimeWeeks(
  merged: ReadonlyArray<MergedRequest>,
  weekStarts: ReadonlyArray<string>,
): InsightsLeadTimeWeek[] {
  const byWeek = groupBy(merged, (request) => request.weekStart);
  return weekStarts.map((weekStart) => {
    const days = (byWeek.get(weekStart) ?? []).flatMap((request) => {
      const value = leadTimeDays(request);
      return value === null ? [] : [value];
    });
    return {
      weekStart,
      count: days.length,
      medianDays: roundOrNull(median(days)),
      p85Days: roundOrNull(quantile(days, 0.85)),
    };
  });
}

function leadTimeSection(
  merged: ReadonlyArray<MergedRequest>,
  weekStarts: ReadonlyArray<string>,
  contributorIds: ReadonlyArray<string>,
): InsightsLeadTime {
  const byAuthor = groupBy(merged, (request) => request.mergeRequest.authorContributorId);
  return {
    weeks: leadTimeWeeks(merged, weekStarts),
    contributors: contributorIds.flatMap((contributorId) => {
      const requests = byAuthor.get(contributorId) ?? [];
      if (!requests.some((request) => leadTimeDays(request) !== null)) return [];
      return [{ contributorId: asId(contributorId), weeks: leadTimeWeeks(requests, weekStarts) }];
    }),
  };
}

function sizeSection(
  merged: ReadonlyArray<MergedRequest>,
  contributorIds: ReadonlyArray<string>,
): { readonly buckets: InsightsSizeBucket[] } {
  const sized = merged.filter((request) => request.lines !== null);
  const byBucket = groupBy(sized, (request) => String(sizeBucketIndex(request.lines!)));
  return {
    buckets: SIZE_BUCKETS.map((bucket, index) => {
      const requests = byBucket.get(String(index)) ?? [];
      const byAuthor = groupBy(requests, (request) => request.mergeRequest.authorContributorId);
      return {
        min: bucket.min,
        max: bucket.max,
        count: requests.length,
        medianChangedFiles: roundOrNull(
          median(
            requests.flatMap((request) =>
              request.mergeRequest.changedFiles === null ? [] : [request.mergeRequest.changedFiles],
            ),
          ),
        ),
        medianFirstReviewHours: roundOrNull(
          median(
            requests.flatMap((request) =>
              request.mergeRequest.firstReviewAt === null
                ? []
                : [
                    hoursBetween(
                      request.mergeRequest.createdAt,
                      request.mergeRequest.firstReviewAt,
                    ),
                  ],
            ),
          ),
        ),
        byContributor: contributorIds.flatMap((contributorId) => {
          const count = byAuthor.get(contributorId)?.length ?? 0;
          return count === 0 ? [] : [{ contributorId: asId(contributorId), count }];
        }),
      };
    }),
  };
}

function reviewsSection(
  reviews: ReadonlyArray<RollupReview>,
  merged: ReadonlyArray<MergedRequest>,
  contributorIds: ReadonlyArray<string>,
): InsightsReviews {
  const known = new Set(contributorIds);
  const cells = new Map<
    string,
    { reviewer: string; author: string; keys: Set<string>; numbers: Set<number> }
  >();
  for (const review of reviews) {
    const author = review.authorContributorId;
    if (author === null || !known.has(author) || !known.has(review.reviewerContributorId)) continue;
    const key = `${review.reviewerContributorId}\u0000${author}`;
    const cell = cells.get(key) ?? {
      reviewer: review.reviewerContributorId,
      author,
      keys: new Set<string>(),
      numbers: new Set<number>(),
    };
    cell.keys.add(review.mergeRequestKey);
    cell.numbers.add(review.mergeRequestNumber);
    cells.set(key, cell);
  }
  const byAuthor = groupBy(merged, (request) => request.mergeRequest.authorContributorId);
  return {
    cells: [...cells.values()].map((cell) => ({
      reviewerContributorId: asId(cell.reviewer),
      authorContributorId: asId(cell.author),
      count: cell.keys.size,
      mergeRequests: [...cell.numbers].toSorted((a, b) => a - b),
    })),
    unreviewedMergesByAuthor: contributorIds.flatMap((contributorId) => {
      const requests = byAuthor.get(contributorId) ?? [];
      if (requests.length === 0) return [];
      return [
        {
          contributorId: asId(contributorId),
          merged: requests.length,
          unreviewed: requests.filter(
            (request) => !reviewedBeforeMerge(request.mergeRequest, request.mergedAt),
          ).length,
        },
      ];
    }),
  };
}

/** Landed hours per issue type; ties fall back to the type's name so the order is stable. */
function jiraSection(
  landed: ReadonlyArray<RollupCommit & { readonly landedAt: string }>,
  issues: ReadonlyArray<RollupJiraIssue>,
  weekStarts: ReadonlyArray<string>,
  contributorIds: ReadonlyArray<string>,
): InsightsJira {
  const typeByKey = new Map(issues.map((issue) => [issue.key, issue.issueType]));
  const byType = new Map<string, { hours: number; commits: number }>();
  const byContributor = new Map<string, Map<string, number>>();
  const weeks = new Map(
    weekStarts.map((weekStart) => [weekStart, { landedHours: 0, unticketedHours: 0 }]),
  );
  for (const commit of landed) {
    const types =
      commit.jiraKeys.length === 0
        ? [INSIGHTS_JIRA_UNTICKETED]
        : commit.jiraKeys.map((key) => typeByKey.get(key) ?? INSIGHTS_JIRA_UNKNOWN);
    const share = commit.estimatedHours / types.length;
    const contributor = byContributor.get(commit.contributorId) ?? new Map<string, number>();
    byContributor.set(commit.contributorId, contributor);
    for (const type of types) {
      const entry = byType.get(type) ?? { hours: 0, commits: 0 };
      entry.hours += share;
      byType.set(type, entry);
      contributor.set(type, (contributor.get(type) ?? 0) + share);
    }
    for (const type of new Set(types)) byType.get(type)!.commits += 1;
    const week = weeks.get(weekStartOf(commit.landedAt.slice(0, 10)));
    if (week !== undefined) {
      week.landedHours += commit.estimatedHours;
      if (commit.jiraKeys.length === 0) week.unticketedHours += commit.estimatedHours;
    }
  }
  const ranked = <A>(entries: Iterable<[string, A]>, hours: (value: A) => number) =>
    [...entries].toSorted(
      ([leftType, left], [rightType, right]) =>
        hours(right) - hours(left) || leftType.localeCompare(rightType),
    );
  return {
    byType: ranked(byType, (entry) => entry.hours).map(([issueType, entry]) => ({
      issueType,
      landedHours: round(entry.hours),
      commits: entry.commits,
    })),
    byTypeByContributor: contributorIds.flatMap((contributorId) => {
      const hours = byContributor.get(contributorId);
      return hours === undefined
        ? []
        : [
            {
              contributorId: asId(contributorId),
              hoursByType: ranked(hours, (value) => value).map(([issueType, value]) => ({
                issueType,
                landedHours: round(value),
              })),
            },
          ];
    }),
    weeks: [...weeks].map(([weekStart, week]) => ({
      weekStart,
      landedHours: round(week.landedHours),
      unticketedHours: round(week.unticketedHours),
    })),
  };
}

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
      contributorId: asId(contributor.contributorId),
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

  const weekStarts = [...weeks.keys()];
  const contributorIds = input.contributors.map((contributor) => contributor.contributorId);
  const live = input.commits.filter(
    (commit) => !commit.superseded && totals.has(commit.contributorId),
  );

  const byContributorWeek = new Map<string, { pushedHours: number; landedHours: number }>();
  const contributorWeek = (weekStart: string, contributorId: string) => {
    const key = `${weekStart}\u0000${contributorId}`;
    const entry = byContributorWeek.get(key) ?? { pushedHours: 0, landedHours: 0 };
    byContributorWeek.set(key, entry);
    return entry;
  };
  const mixByContributor = new Map<
    string,
    { hours: Record<InsightsCommitType, number>; commits: Record<InsightsCommitType, number> }
  >();
  const mixByWeek = new Map(
    weekStarts.map((weekStart) => [weekStart, { hours: emptyByType(), commits: emptyByType() }]),
  );
  let pushedHours = 0;
  let agentHours = 0;
  const landedByMergeRequest = new Map<string, string>();
  const linesByMergeRequest = new Map<string, number>();
  for (const commit of live) {
    if (commit.mergeRequestKey !== null) {
      linesByMergeRequest.set(
        commit.mergeRequestKey,
        (linesByMergeRequest.get(commit.mergeRequestKey) ?? 0) +
          commit.additions +
          commit.deletions,
      );
      const landed = landedByMergeRequest.get(commit.mergeRequestKey);
      if (commit.landedAt !== null && (landed === undefined || commit.landedAt < landed)) {
        landedByMergeRequest.set(commit.mergeRequestKey, commit.landedAt);
      }
    }
    if (inWindow(commit.authoredAt)) {
      pushedHours += commit.estimatedHours;
      if (commit.hasAgentCoauthor) agentHours += commit.estimatedHours;
      contributorWeek(
        weekStartOf(commit.authoredAt.slice(0, 10)),
        commit.contributorId,
      ).pushedHours += commit.estimatedHours;
    }
    if (inWindow(commit.landedAt)) {
      const weekStart = weekStartOf(commit.landedAt.slice(0, 10));
      contributorWeek(weekStart, commit.contributorId).landedHours += commit.estimatedHours;
      const type = commitTypeOf(commit.messageSubject);
      const mix = mixByContributor.get(commit.contributorId) ?? {
        hours: emptyByType(),
        commits: emptyByType(),
      };
      mix.hours[type] += commit.estimatedHours;
      mix.commits[type] += 1;
      mixByContributor.set(commit.contributorId, mix);
      const week = mixByWeek.get(weekStart);
      if (week !== undefined) {
        week.hours[type] += commit.estimatedHours;
        week.commits[type] += 1;
      }
    }
  }

  const merged: MergedRequest[] = input.mergeRequests.flatMap((mergeRequest) =>
    totals.has(mergeRequest.authorContributorId) && inWindow(mergeRequest.mergedAt)
      ? [
          {
            mergeRequest,
            mergedAt: mergeRequest.mergedAt,
            weekStart: weekStartOf(mergeRequest.mergedAt.slice(0, 10)),
            landedAt: landedByMergeRequest.get(mergeRequest.mergeRequestKey) ?? null,
            lines: linesByMergeRequest.get(mergeRequest.mergeRequestKey) ?? null,
          },
        ]
      : [],
  );
  const abandoned = input.mergeRequests.filter(
    (mergeRequest) =>
      totals.has(mergeRequest.authorContributorId) &&
      mergeRequest.state === "closed" &&
      mergeRequest.mergedAt === null &&
      inWindow(mergeRequest.closedAt),
  ).length;

  const byContributorWeeks: InsightsContributorWeek[] = weekStarts.flatMap((weekStart) =>
    contributorIds.flatMap((contributorId) => {
      const entry = byContributorWeek.get(`${weekStart}\u0000${contributorId}`);
      return entry === undefined
        ? []
        : [
            {
              weekStart,
              contributorId: asId(contributorId),
              pushedHours: round(entry.pushedHours),
              landedHours: round(entry.landedHours),
            },
          ];
    }),
  );
  const mix: InsightsMix = {
    contributors: contributorIds.flatMap((contributorId) => {
      const entry = mixByContributor.get(contributorId);
      return entry === undefined
        ? []
        : [
            {
              contributorId: asId(contributorId),
              hoursByType: roundByType(entry.hours),
              commitsByType: entry.commits,
            },
          ];
    }),
    weeks: [...mixByWeek].map(([weekStart, entry]) => ({
      weekStart,
      hoursByType: roundByType(entry.hours),
      commitsByType: entry.commits,
    })),
  };
  const leadTimes = merged.flatMap((request) => {
    const days = leadTimeDays(request);
    return days === null ? [] : [days];
  });
  const landed = live.flatMap((commit) =>
    inWindow(commit.landedAt) ? [{ ...commit, landedAt: commit.landedAt }] : [],
  );
  const jira = input.jiraConfigured
    ? jiraSection(landed, input.jiraIssues, weekStarts, contributorIds)
    : null;
  const share = (part: number, whole: number) => (whole > 0 ? round(part / whole) : null);
  const headline: InsightsHeadline = {
    leadTimeMedianDays: roundOrNull(median(leadTimes)),
    medianMergeRequestLines: roundOrNull(
      median(merged.flatMap((request) => (request.lines === null ? [] : [request.lines]))),
    ),
    unreviewedMergeShare: share(
      merged.filter((request) => !reviewedBeforeMerge(request.mergeRequest, request.mergedAt))
        .length,
      merged.length,
    ),
    agentAssistedShare: share(agentHours, pushedHours),
    abandonedShare: share(abandoned, abandoned + merged.length),
    unticketedShare:
      jira === null
        ? null
        : share(
            landed.reduce(
              (sum, commit) => sum + (commit.jiraKeys.length === 0 ? commit.estimatedHours : 0),
              0,
            ),
            landed.reduce((sum, commit) => sum + commit.estimatedHours, 0),
          ),
  };

  return {
    from: input.from,
    to: input.to,
    workingDays,
    weeks: weekRows,
    contributors,
    byContributorWeeks,
    cycle: cycleSection(merged, weekStarts, contributorIds),
    leadTime: leadTimeSection(merged, weekStarts, contributorIds),
    size: sizeSection(merged, contributorIds),
    mix,
    reviews: reviewsSection(
      input.reviews.filter((review) => inWindow(review.firstAt)),
      merged,
      contributorIds,
    ),
    jira,
    headline,
  };
}
