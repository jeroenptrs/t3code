import { describe, expect, it } from "@effect/vitest";

import { rollup, weekStartOf, workingDaysBetween } from "./insightsRollup.ts";

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
) => ({ contributorId, authoredAt, landedAt, estimatedHours, superseded });

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

describe("rollup", () => {
  const base = {
    from: "2026-10-12",
    to: "2026-10-25",
    today: "2026-10-30",
    contributors,
    mergeRequests: [],
    reviews: [],
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
      mergeRequests: [
        {
          authorContributorId: "ada",
          createdAt: "2026-10-13T10:00:00Z",
          mergedAt: "2026-10-14T10:00:00Z",
          firstReviewAt: "2026-10-13T12:00:00Z",
          firstCommitAuthoredAt: "2026-10-12T10:00:00Z",
        },
      ],
      reviews: [
        { reviewerContributorId: "bob", mergeRequestKey: "p:1", firstAt: "2026-10-13T12:00:00Z" },
        { reviewerContributorId: "bob", mergeRequestKey: "p:1", firstAt: "2026-10-13T13:00:00Z" },
        { reviewerContributorId: "bob", mergeRequestKey: "p:2", firstAt: "2026-09-01T00:00:00Z" },
      ],
    });
    const ada = overview.contributors.find((row) => row.contributorId === "ada")!;
    expect(ada.mergeRequestsMerged).toBe(1);
    expect(ada.medianFirstReviewHours).toBe(2);
    expect(ada.medianCycleHours).toBe(48);
    expect(overview.contributors.find((row) => row.contributorId === "bob")!.reviewsGiven).toBe(1);
  });
});
