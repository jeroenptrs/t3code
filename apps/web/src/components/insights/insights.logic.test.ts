import type { InsightsContributorRow } from "@t3tools/contracts";
import { InsightsContributorId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  insightsWindowForWeeks,
  isInsightsAuthenticationError,
  nextInsightsSort,
  parseInsightsBranchPatterns,
  sortInsightsRows,
} from "./insights.logic";

const row = (
  name: string,
  landedHours: number,
  medianFirstReviewHours: number | null,
): InsightsContributorRow => ({
  contributorId: InsightsContributorId.make(name),
  displayName: name,
  kind: "human",
  pushedHours: 0,
  landedHours,
  landedShare: null,
  throughput: 0,
  commits: 0,
  mergeRequestsMerged: 0,
  reviewsGiven: 0,
  medianFirstReviewHours,
  medianCycleHours: null,
});

describe("insightsWindowForWeeks", () => {
  it("starts on the Monday that makes the window whole weeks", () => {
    // Thursday 2026-10-22.
    expect(insightsWindowForWeeks(4, new Date("2026-10-22T15:00:00Z"))).toEqual({
      from: "2026-09-28",
      to: "2026-10-22",
    });
    // A Monday counts as the first day of its own week.
    expect(insightsWindowForWeeks(1, new Date("2026-10-19T00:30:00Z"))).toEqual({
      from: "2026-10-19",
      to: "2026-10-19",
    });
  });
});

describe("sortInsightsRows", () => {
  const rows = [row("Bea", 3, null), row("Ada", 10, 2), row("Cy", 3, 5)];

  it("sorts by the column and breaks ties by name", () => {
    expect(
      sortInsightsRows(rows, { key: "landedHours", direction: "desc" }).map((r) => r.displayName),
    ).toEqual(["Ada", "Bea", "Cy"]);
    expect(
      sortInsightsRows(rows, { key: "landedHours", direction: "asc" }).map((r) => r.displayName),
    ).toEqual(["Bea", "Cy", "Ada"]);
  });

  it("keeps missing values last in both directions", () => {
    for (const direction of ["asc", "desc"] as const) {
      expect(
        sortInsightsRows(rows, { key: "medianFirstReviewHours", direction }).at(-1)?.displayName,
      ).toBe("Bea");
    }
  });

  it("flips the current column and starts names ascending", () => {
    expect(nextInsightsSort({ key: "landedHours", direction: "desc" }, "landedHours")).toEqual({
      key: "landedHours",
      direction: "asc",
    });
    expect(nextInsightsSort({ key: "landedHours", direction: "desc" }, "displayName")).toEqual({
      key: "displayName",
      direction: "asc",
    });
  });
});

describe("settings helpers", () => {
  it("splits branch patterns on commas and lines", () => {
    expect(parseInsightsBranchPatterns("release/*, hotfix/*\n\n main ")).toEqual([
      "release/*",
      "hotfix/*",
      "main",
    ]);
  });

  it("recognizes a missing glab login", () => {
    expect(isInsightsAuthenticationError("glab is not authenticated for gitlab.example.com")).toBe(
      true,
    );
    expect(isInsightsAuthenticationError("The project checkout is missing.")).toBe(false);
    expect(isInsightsAuthenticationError(null)).toBe(false);
  });
});
