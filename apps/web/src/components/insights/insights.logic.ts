import type {
  InsightsCommitType,
  InsightsContributor,
  InsightsContributorRow,
  InsightsContributorStatus,
} from "@t3tools/contracts";

export const INSIGHTS_ESTIMATE_LABEL = "Model estimate of coding output, not hours worked.";

export const INSIGHTS_WINDOW_WEEKS = [4, 8, 13, 26] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The last `weeks` whole weeks up to today, starting on a Monday so the first bar is a full week
 * like the server's buckets. Days are UTC, as the server stores them.
 */
export function insightsWindowForWeeks(
  weeks: number,
  now: Date,
): { readonly from: string; readonly to: string } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const sinceMonday = (today.getUTCDay() + 6) % 7;
  const from = new Date(today.getTime() - (sinceMonday + (weeks - 1) * 7) * DAY_MS);
  return { from: utcDay(from), to: utcDay(today) };
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isInsightsDayRange(from: string, to: string): boolean {
  return DAY_PATTERN.test(from) && DAY_PATTERN.test(to) && from <= to;
}

export type InsightsSortKey = Exclude<keyof InsightsContributorRow, "contributorId" | "kind">;
type InsightsSortDirection = "asc" | "desc";

export interface InsightsSort {
  readonly key: InsightsSortKey;
  readonly direction: InsightsSortDirection;
}

export const INSIGHTS_DEFAULT_SORT: InsightsSort = { key: "landedHours", direction: "desc" };

/** Rows with no value for the column stay last in either direction. */
export function sortInsightsRows(
  rows: ReadonlyArray<InsightsContributorRow>,
  sort: InsightsSort,
): ReadonlyArray<InsightsContributorRow> {
  const sign = sort.direction === "asc" ? 1 : -1;
  return rows.toSorted((left, right) => {
    const a = left[sort.key];
    const b = right[sort.key];
    if (a === null || b === null) {
      if (a === b) return left.displayName.localeCompare(right.displayName);
      return a === null ? 1 : -1;
    }
    const compared =
      typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
    return compared === 0 ? left.displayName.localeCompare(right.displayName) : sign * compared;
  });
}

/** Clicking the sorted column flips it; a new column starts with its most useful direction. */
export function nextInsightsSort(current: InsightsSort, key: InsightsSortKey): InsightsSort {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: key === "displayName" ? "asc" : "desc" };
}

export function formatInsightsHours(hours: number | null): string {
  if (hours === null) return "-";
  return hours >= 100 ? `${Math.round(hours)}h` : `${hours.toFixed(1)}h`;
}

export function formatInsightsShare(share: number | null): string {
  return share === null ? "-" : `${Math.round(share * 100)}%`;
}

export function formatInsightsMultiple(value: number): string {
  return `${value.toFixed(2)}x`;
}

export function insightsContributorLabel(
  contributor: Pick<
    InsightsContributor,
    "contributorId" | "displayName" | "gitlabLogin" | "emails"
  >,
): string {
  return (
    contributor.displayName ??
    contributor.gitlabLogin ??
    contributor.emails[0] ??
    contributor.contributorId
  );
}

export function insightsContributorsWithStatus(
  contributors: ReadonlyArray<InsightsContributor>,
  status: InsightsContributorStatus,
): ReadonlyArray<InsightsContributor> {
  return contributors
    .filter((contributor) => contributor.status === status)
    .toSorted((left, right) =>
      insightsContributorLabel(left).localeCompare(insightsContributorLabel(right)),
    );
}

/** One pattern per line or comma, blanks dropped. */
export function parseInsightsBranchPatterns(text: string): ReadonlyArray<string> {
  return text
    .split(/[\n,]/)
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
}

/** The provider error for a missing or expired `glab` login names authentication. */
export function isInsightsAuthenticationError(lastError: string | null): boolean {
  return lastError !== null && /auth|log ?in|credential|401|unauthori[sz]ed/i.test(lastError);
}

export const INSIGHTS_CHARTS = [
  {
    key: "trend",
    title: "Team trend",
    description: "Pushed and landed hours per active contributor, with the landed share to date.",
  },
  {
    key: "cycle",
    title: "Cycle time",
    description:
      "Median hours a merged merge request spent coding, waiting, in review and to trunk.",
  },
  {
    key: "leadTime",
    title: "Lead time",
    description:
      "Median days from a merge request's first commit to landing, with the 85th percentile.",
  },
  {
    key: "size",
    title: "Merge request size",
    description: "Merged merge requests by lines added and deleted.",
  },
  {
    key: "mix",
    title: "Work mix",
    description: "Landed hours by conventional commit type.",
  },
  {
    key: "reviews",
    title: "Reviews",
    description: "Merge requests each person reviewed, by author.",
  },
] as const;

export type InsightsChartKey = (typeof INSIGHTS_CHARTS)[number]["key"];
export type InsightsChart = (typeof INSIGHTS_CHARTS)[number];

export function insightsChartByKey(key: string): InsightsChart | null {
  return INSIGHTS_CHARTS.find((chart) => chart.key === key) ?? null;
}

/** The window and contributor filter shared by the overview and every expanded chart. */
export interface InsightsSearch {
  readonly from?: string;
  readonly to?: string;
  /** Absent for every included contributor; empty selects nobody. */
  readonly contributors?: ReadonlyArray<string> | undefined;
}

export function parseInsightsSearch(raw: Record<string, unknown>): InsightsSearch {
  const contributors = Array.isArray(raw.contributors)
    ? raw.contributors.filter((value): value is string => typeof value === "string")
    : undefined;
  return {
    ...(typeof raw.from === "string" && DAY_PATTERN.test(raw.from) ? { from: raw.from } : {}),
    ...(typeof raw.to === "string" && DAY_PATTERN.test(raw.to) ? { to: raw.to } : {}),
    ...(contributors === undefined ? {} : { contributors }),
  };
}

/** The preset a window matches, or `custom`. */
export function insightsWindowChoice(
  range: { readonly from: string; readonly to: string },
  now: Date,
): (typeof INSIGHTS_WINDOW_WEEKS)[number] | "custom" {
  return (
    INSIGHTS_WINDOW_WEEKS.find((weeks) => {
      const preset = insightsWindowForWeeks(weeks, now);
      return preset.from === range.from && preset.to === range.to;
    }) ?? "custom"
  );
}

export function formatInsightsDays(days: number | null): string {
  return days === null ? "-" : `${days.toFixed(1)}d`;
}

export function formatInsightsSizeBucket(bucket: {
  readonly min: number;
  readonly max: number | null;
}): string {
  if (bucket.max === null) return `>${bucket.min - 1}`;
  if (bucket.min === 0) return `<${bucket.max + 1}`;
  return `${bucket.min}–${bucket.max}`;
}

const COMMIT_TYPE_LABELS: Record<InsightsCommitType, string> = {
  feat: "Features",
  fix: "Fixes",
  chore: "Chores",
  docs: "Docs",
  test: "Tests",
  other: "Other",
};

export function insightsCommitTypeLabel(type: InsightsCommitType): string {
  return COMMIT_TYPE_LABELS[type];
}

export function insightsWeekLabel(weekStart: string): string {
  const date = new Date(`${weekStart}T00:00:00Z`);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** `12.0h median, 30.0h p85`, or `-` when nothing was measured. */
export function formatInsightsSpread(
  spread: { readonly median: number | null; readonly p85: number | null },
  format: (value: number | null) => string = formatInsightsHours,
): string {
  return spread.median === null
    ? "-"
    : `${format(spread.median)} median, ${format(spread.p85)} p85`;
}

const INSIGHTS_MAX_SERIES = 6;

/**
 * The series a chart draws: every id when they fit, otherwise the largest five and `other` for
 * the rest, so no chart needs more than six colors.
 */
export function insightsSeries(
  totals: ReadonlyArray<{ readonly id: string; readonly total: number }>,
): { readonly shown: ReadonlyArray<string>; readonly folded: ReadonlyArray<string> } {
  const ranked = totals
    .filter((entry) => entry.total > 0)
    .toSorted((left, right) => right.total - left.total);
  if (ranked.length <= INSIGHTS_MAX_SERIES) {
    return { shown: ranked.map((entry) => entry.id), folded: [] };
  }
  return {
    shown: ranked.slice(0, INSIGHTS_MAX_SERIES - 1).map((entry) => entry.id),
    folded: ranked.slice(INSIGHTS_MAX_SERIES - 1).map((entry) => entry.id),
  };
}
