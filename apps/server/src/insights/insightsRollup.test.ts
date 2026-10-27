import { describe, expect, it } from "@effect/vitest";

import {
  commitTypeOf,
  cycleSegmentsOf,
  quantile,
  type RollupCommit,
  type RollupMergeRequest,
  rollup,
  sizeBucketIndex,
  weekStartOf,
  workingDaysBetween,
} from "./insightsRollup.ts";

const contributors = [
  { contributorId: "ada", displayName: "Ada", kind: "human" as const },
  { contributorId: "bob", displayName: "Bob", kind: "human" as const },
];

const commit = (
  contributorId: string,
  authoredAt: string,
  landedAt: string | null,
  estimatedHours: number,
  superseded = false,
  extra: Partial<RollupCommit> = {},
): RollupCommit => ({
  contributorId,
  authoredAt,
  landedAt,
  estimatedHours,
  superseded,
  mergeRequestKey: null,
  messageSubject: "change",
  hasAgentCoauthor: false,
  additions: 0,
  deletions: 0,
  jiraKeys: [],
  ...extra,
});

const mergeRequest = (
  number: number,
  extra: Partial<RollupMergeRequest> = {},
): RollupMergeRequest => ({
  authorContributorId: "ada",
  mergeRequestKey: `p:${number}`,
  number,
  state: "merged",
  createdAt: "2026-10-13T10:00:00Z",
  mergedAt: "2026-10-14T10:00:00Z",
  closedAt: null,
  firstReviewAt: "2026-10-13T12:00:00Z",
  firstCommitAuthoredAt: "2026-10-12T10:00:00Z",
  changedFiles: null,
  ...extra,
});

describe("quantile", () => {
  it("interpolates between ranks and is null without values", () => {
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.85)).toBeCloseTo(3.55);
    expect(quantile([7], 0.85)).toBe(7);
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe("sizeBucketIndex", () => {
  it("puts each edge in the bucket that names it", () => {
    expect([0, 49, 50, 200, 201, 500, 501, 1000, 1001].map(sizeBucketIndex)).toEqual([
      0, 0, 1, 1, 2, 2, 3, 3, 4,
    ]);
  });
});

describe("commitTypeOf", () => {
  it("reads the conventional type and folds the rest into other", () => {
    expect(commitTypeOf("feat(VIC-1)!: x")).toBe("feat");
    expect(commitTypeOf("Fix: y")).toBe("fix");
    expect(commitTypeOf("perf: z")).toBe("other");
    expect(commitTypeOf("Merge branch 'main' into feature")).toBe("other");
    expect(commitTypeOf("add a thing")).toBe("other");
  });
});

describe("cycleSegmentsOf", () => {
  it("splits coding, pickup, review and to trunk", () => {
    expect(
      cycleSegmentsOf(mergeRequest(1), "2026-10-14T10:00:00Z", "2026-10-14T12:00:00Z"),
    ).toEqual({ coding: 24, pickup: 2, review: 22, toTrunk: 2 });
  });

  it("runs pickup to the merge without a review and leaves to trunk out until landed", () => {
    const unreviewed = mergeRequest(1, { firstReviewAt: null, firstCommitAuthoredAt: null });
    expect(cycleSegmentsOf(unreviewed, "2026-10-14T10:00:00Z", null)).toEqual({
      coding: null,
      pickup: 24,
      review: null,
      toTrunk: null,
    });
  });

  it("treats a review after the merge as no review", () => {
    const late = mergeRequest(1, { firstReviewAt: "2026-10-15T10:00:00Z" });
    expect(cycleSegmentsOf(late, "2026-10-14T10:00:00Z", null)).toMatchObject({
      pickup: 24,
      review: null,
    });
  });
});

describe("weekStartOf", () => {
  it("returns the Monday of the week", () => {
    expect(weekStartOf("2026-10-22")).toBe("2026-10-19");
    expect(weekStartOf("2026-10-19")).toBe("2026-10-19");
    expect(weekStartOf("2026-10-25")).toBe("2026-10-19");
  });
});

describe("workingDaysBetween", () => {
  it("counts Monday to Friday", () => {
    expect(workingDaysBetween("2026-10-19", "2026-10-25")).toBe(5);
    expect(workingDaysBetween("2026-10-24", "2026-10-25")).toBe(0);
  });
});

const review = (
  reviewer: string,
  number: number,
  firstAt: string,
  author: string | null = "ada",
) => ({
  reviewerContributorId: reviewer,
  mergeRequestKey: `p:${number}`,
  mergeRequestNumber: number,
  authorContributorId: author,
  firstAt,
});

describe("rollup", () => {
  const base = {
    from: "2026-10-12",
    to: "2026-10-25",
    today: "2026-10-30",
    contributors,
    mergeRequests: [],
    reviews: [],
    jiraIssues: [],
    jiraConfigured: false,
  };

  it("buckets pushed by authored day and landed by landed day", () => {
    const overview = rollup({
      ...base,
      commits: [
        commit("ada", "2026-10-13T10:00:00Z", "2026-10-20T09:00:00Z", 2),
        commit("ada", "2026-10-21T10:00:00Z", null, 1),
      ],
    });
    expect(overview.weeks).toEqual([
      { weekStart: "2026-10-12", pushedHours: 2, landedHours: 0, activeContributors: 1 },
      { weekStart: "2026-10-19", pushedHours: 1, landedHours: 2, activeContributors: 1 },
    ]);
    const ada = overview.contributors.find((row) => row.contributorId === "ada")!;
    expect(ada.pushedHours).toBe(3);
    expect(ada.landedHours).toBe(2);
    expect(ada.landedShare).toBe(0.67);
    expect(ada.commits).toBe(2);
  });

  it("leaves superseded commits out of pushed and landed", () => {
    const overview = rollup({
      ...base,
      commits: [
        commit("ada", "2026-10-13T10:00:00Z", "2026-10-14T10:00:00Z", 2, true),
        commit("ada", "2026-10-14T10:00:00Z", "2026-10-14T10:00:00Z", 2),
      ],
    });
    const ada = overview.contributors.find((row) => row.contributorId === "ada")!;
    expect(ada.pushedHours).toBe(2);
    expect(ada.landedHours).toBe(2);
    expect(ada.commits).toBe(1);
  });

  it("divides pushed hours by working days times eight", () => {
    const overview = rollup({
      ...base,
      commits: [commit("bob", "2026-10-13T10:00:00Z", null, 40)],
    });
    expect(overview.workingDays).toBe(10);
    expect(overview.contributors.find((row) => row.contributorId === "bob")!.throughput).toBe(0.5);
  });

  it("stops counting working days at today", () => {
    expect(rollup({ ...base, today: "2026-10-16", commits: [] }).workingDays).toBe(5);
  });

  it("reports merge request timing and distinct reviews", () => {
    const overview = rollup({
      ...base,
      commits: [],
      mergeRequests: [mergeRequest(1)],
      reviews: [
        review("bob", 1, "2026-10-13T12:00:00Z"),
        review("bob", 1, "2026-10-13T13:00:00Z"),
        review("bob", 2, "2026-09-01T00:00:00Z"),
      ],
    });
    const ada = overview.contributors.find((row) => row.contributorId === "ada")!;
    expect(ada.mergeRequestsMerged).toBe(1);
    expect(ada.medianFirstReviewHours).toBe(2);
    expect(ada.medianCycleHours).toBe(48);
    expect(overview.contributors.find((row) => row.contributorId === "bob")!.reviewsGiven).toBe(1);
  });

  it("reports cycle and lead time by merge week from the earliest landed commit", () => {
    const overview = rollup({
      ...base,
      commits: [
        commit("ada", "2026-10-12T10:00:00Z", "2026-10-16T10:00:00Z", 1, false, {
          mergeRequestKey: "p:1",
        }),
        commit("ada", "2026-10-12T11:00:00Z", "2026-10-15T10:00:00Z", 1, false, {
          mergeRequestKey: "p:1",
        }),
      ],
      mergeRequests: [mergeRequest(1), mergeRequest(2, { firstReviewAt: null })],
    });
    const [first, second] = overview.cycle.weeks;
    expect(first).toEqual({
      weekStart: "2026-10-12",
      count: 2,
      coding: { median: 24, p85: 24 },
      pickup: { median: 13, p85: 20.7 },
      review: { median: 22, p85: 22 },
      toTrunk: { median: 24, p85: 24 },
    });
    expect(second!.count).toBe(0);
    expect(second!.pickup).toEqual({ median: null, p85: null });
    expect(overview.leadTime.weeks[0]).toEqual({
      weekStart: "2026-10-12",
      count: 1,
      medianDays: 3,
      p85Days: 3,
    });
    expect(overview.leadTime.contributors.map((row) => row.contributorId)).toEqual(["ada"]);
    expect(overview.headline.leadTimeMedianDays).toBe(3);
    expect(overview.headline.unreviewedMergeShare).toBe(0.5);
  });

  it("buckets merged merge requests by the lines of their commits", () => {
    const overview = rollup({
      ...base,
      commits: [
        commit("ada", "2026-10-12T10:00:00Z", null, 1, false, {
          mergeRequestKey: "p:1",
          additions: 30,
          deletions: 20,
        }),
        commit("ada", "2026-10-12T10:00:00Z", null, 1, false, {
          mergeRequestKey: "p:2",
          additions: 49,
        }),
      ],
      mergeRequests: [mergeRequest(1, { changedFiles: 3 }), mergeRequest(2), mergeRequest(3)],
    });
    expect(overview.size.buckets.map((bucket) => bucket.count)).toEqual([1, 1, 0, 0, 0]);
    expect(overview.size.buckets[1]).toMatchObject({
      min: 50,
      max: 200,
      medianChangedFiles: 3,
      medianFirstReviewHours: 2,
      byContributor: [{ contributorId: "ada", count: 1 }],
    });
    expect(overview.headline.medianMergeRequestLines).toBe(49.5);
  });

  it("splits landed hours by commit type per contributor and week", () => {
    const overview = rollup({
      ...base,
      commits: [
        commit("ada", "2026-10-12T10:00:00Z", "2026-10-13T10:00:00Z", 2, false, {
          messageSubject: "feat(VIC-1): x",
        }),
        commit("ada", "2026-10-12T10:00:00Z", "2026-10-20T10:00:00Z", 1, false, {
          messageSubject: "Merge branch 'main'",
        }),
        commit("ada", "2026-10-12T10:00:00Z", null, 5, false, { messageSubject: "fix: y" }),
      ],
    });
    expect(overview.mix.contributors).toEqual([
      {
        contributorId: "ada",
        hoursByType: { feat: 2, fix: 0, chore: 0, docs: 0, test: 0, other: 1 },
        commitsByType: { feat: 1, fix: 0, chore: 0, docs: 0, test: 0, other: 1 },
      },
    ]);
    expect(overview.mix.weeks.map((week) => week.hoursByType.feat)).toEqual([2, 0]);
    expect(overview.byContributorWeeks).toEqual([
      { weekStart: "2026-10-12", contributorId: "ada", pushedHours: 8, landedHours: 2 },
      { weekStart: "2026-10-19", contributorId: "ada", pushedHours: 0, landedHours: 1 },
    ]);
  });

  it("shares pushed hours with an agent co-author and closed merge requests left unmerged", () => {
    const overview = rollup({
      ...base,
      commits: [
        commit("ada", "2026-10-12T10:00:00Z", null, 1, false, { hasAgentCoauthor: true }),
        commit("bob", "2026-10-12T10:00:00Z", null, 3),
      ],
      mergeRequests: [
        mergeRequest(1),
        mergeRequest(2, { state: "closed", mergedAt: null, closedAt: "2026-10-15T10:00:00Z" }),
        mergeRequest(3, { state: "closed", mergedAt: null, closedAt: "2026-09-15T10:00:00Z" }),
      ],
    });
    expect(overview.headline.agentAssistedShare).toBe(0.25);
    expect(overview.headline.abandonedShare).toBe(0.5);
  });

  it("is null rather than zero where there is nothing to measure", () => {
    expect(rollup({ ...base, commits: [] }).headline).toEqual({
      leadTimeMedianDays: null,
      medianMergeRequestLines: null,
      unreviewedMergeShare: null,
      agentAssistedShare: null,
      abandonedShare: null,
      unticketedShare: null,
    });
  });

  it("counts reviews per reviewer and author with the merge request numbers", () => {
    const overview = rollup({
      ...base,
      commits: [],
      mergeRequests: [mergeRequest(1), mergeRequest(2, { firstReviewAt: null })],
      reviews: [
        review("bob", 1, "2026-10-13T12:00:00Z"),
        review("bob", 4, "2026-10-14T12:00:00Z"),
        review("bob", 5, "2026-10-14T12:00:00Z", null),
        review("bob", 6, "2026-09-01T00:00:00Z"),
      ],
    });
    expect(overview.reviews).toEqual({
      cells: [
        {
          reviewerContributorId: "bob",
          authorContributorId: "ada",
          count: 2,
          mergeRequests: [1, 4],
        },
      ],
      unreviewedMergesByAuthor: [{ contributorId: "ada", merged: 2, unreviewed: 1 }],
    });
  });

  it("leaves superseded commits out of every section", () => {
    const overview = rollup({
      ...base,
      commits: [
        commit("ada", "2026-10-12T10:00:00Z", "2026-10-13T10:00:00Z", 4, true, {
          mergeRequestKey: "p:1",
          additions: 500,
          hasAgentCoauthor: true,
          messageSubject: "feat: old",
        }),
        commit("ada", "2026-10-12T10:00:00Z", "2026-10-16T10:00:00Z", 1, false, {
          mergeRequestKey: "p:1",
          additions: 10,
          messageSubject: "fix: new",
        }),
      ],
      mergeRequests: [mergeRequest(1)],
    });
    expect(overview.headline.medianMergeRequestLines).toBe(10);
    expect(overview.headline.agentAssistedShare).toBe(0);
    expect(overview.cycle.weeks[0]!.toTrunk.median).toBe(48);
    expect(overview.mix.contributors[0]!.hoursByType).toMatchObject({ feat: 0, fix: 1 });
    expect(overview.byContributorWeeks).toEqual([
      { weekStart: "2026-10-12", contributorId: "ada", pushedHours: 1, landedHours: 1 },
    ]);
  });

  describe("Jira grouping", () => {
    const jira = {
      ...base,
      jiraConfigured: true,
      jiraIssues: [
        { key: "ACME-1", issueType: "Story", parentKey: "ACME-100" },
        { key: "ACME-2", issueType: "Bug", parentKey: null },
        { key: "ACME-3", issueType: null, parentKey: null },
      ],
    };

    it("is null when Jira is not configured", () => {
      const overview = rollup({
        ...base,
        commits: [commit("ada", "2026-10-12T10:00:00Z", "2026-10-13T10:00:00Z", 2)],
      });
      expect(overview.jira).toBeNull();
      expect(overview.headline.unticketedShare).toBeNull();
    });

    it("splits a commit's landed hours evenly across its keys", () => {
      const overview = rollup({
        ...jira,
        commits: [
          commit("ada", "2026-10-12T10:00:00Z", "2026-10-13T10:00:00Z", 3, false, {
            jiraKeys: ["ACME-1", "ACME-2", "ACME-4"],
          }),
          commit("ada", "2026-10-12T10:00:00Z", "2026-10-13T10:00:00Z", 1, false, {
            jiraKeys: ["ACME-1"],
          }),
        ],
      });
      expect(overview.jira!.byType).toEqual([
        { issueType: "Story", landedHours: 2, commits: 2 },
        { issueType: "Bug", landedHours: 1, commits: 1 },
        { issueType: "Unknown", landedHours: 1, commits: 1 },
      ]);
      expect(overview.jira!.byTypeByContributor).toEqual([
        {
          contributorId: "ada",
          hoursByType: [
            { issueType: "Story", landedHours: 2 },
            { issueType: "Bug", landedHours: 1 },
            { issueType: "Unknown", landedHours: 1 },
          ],
        },
      ]);
    });

    it("counts commits without keys as unticketed and keys Jira did not return as unknown", () => {
      const overview = rollup({
        ...jira,
        commits: [
          commit("ada", "2026-10-12T10:00:00Z", "2026-10-13T10:00:00Z", 1),
          commit("bob", "2026-10-12T10:00:00Z", "2026-10-14T10:00:00Z", 2, false, {
            jiraKeys: ["ACME-3", "ACME-9"],
          }),
          // Not landed, or superseded: neither counts.
          commit("ada", "2026-10-12T10:00:00Z", null, 5),
          commit("ada", "2026-10-12T10:00:00Z", "2026-10-13T10:00:00Z", 5, true),
        ],
      });
      expect(overview.jira!.byType).toEqual([
        { issueType: "Unknown", landedHours: 2, commits: 1 },
        { issueType: "Unticketed", landedHours: 1, commits: 1 },
      ]);
    });

    it("reports unticketed hours per week and the unticketed share", () => {
      const overview = rollup({
        ...jira,
        commits: [
          commit("ada", "2026-10-12T10:00:00Z", "2026-10-13T10:00:00Z", 1),
          commit("ada", "2026-10-12T10:00:00Z", "2026-10-13T10:00:00Z", 2, false, {
            jiraKeys: ["ACME-1"],
          }),
          commit("bob", "2026-10-12T10:00:00Z", "2026-10-20T10:00:00Z", 1, false, {
            jiraKeys: ["ACME-2"],
          }),
        ],
      });
      expect(overview.jira!.weeks).toEqual([
        { weekStart: "2026-10-12", landedHours: 3, unticketedHours: 1 },
        { weekStart: "2026-10-19", landedHours: 1, unticketedHours: 0 },
      ]);
      expect(overview.headline.unticketedShare).toBe(0.25);
      expect(rollup({ ...jira, commits: [] }).headline.unticketedShare).toBeNull();
    });
  });
});
