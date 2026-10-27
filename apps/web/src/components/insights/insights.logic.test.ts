import type { InsightsContributorRow } from "@t3tools/contracts";
import { InsightsContributorId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatInsightsSizeBucket,
  formatInsightsSpread,
  formatInsightsHoursOf,
  insightsChartByKey,
  insightsJiraSeries,
  insightsJiraTypeLabel,
  insightsSeries,
  insightsUnticketedShare,
  insightsWindowChoice,
  insightsWindowForWeeks,
  parseInsightsSearch,
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

describe("insightsChartByKey", () => {
  it("knows every chart and nothing else", () => {
    expect(insightsChartByKey("leadTime")?.title).toBe("Lead time");
    expect(insightsChartByKey("toString")).toBeNull();
  });
});

describe("parseInsightsSearch", () => {
  it("keeps valid days and contributor lists and drops the rest", () => {
    expect(
      parseInsightsSearch({ from: "2026-10-01", to: "yesterday", contributors: ["ada", 7] }),
    ).toEqual({ from: "2026-10-01", contributors: ["ada"] });
    expect(parseInsightsSearch({ contributors: [] })).toEqual({ contributors: [] });
    expect(parseInsightsSearch({})).toEqual({});
  });
});

describe("insightsWindowChoice", () => {
  it("names the preset a window matches and calls anything else custom", () => {
    const now = new Date("2026-10-22T15:00:00Z");
    expect(insightsWindowChoice(insightsWindowForWeeks(8, now), now)).toBe(8);
    expect(insightsWindowChoice({ from: "2026-10-01", to: "2026-10-22" }, now)).toBe("custom");
  });
});

describe("formatInsightsSizeBucket", () => {
  it("labels open ends with < and >", () => {
    expect(formatInsightsSizeBucket({ min: 0, max: 49 })).toBe("<50");
    expect(formatInsightsSizeBucket({ min: 50, max: 200 })).toBe("50–200");
    expect(formatInsightsSizeBucket({ min: 1001, max: null })).toBe(">1000");
  });
});

describe("formatInsightsSpread", () => {
  it("shows the median beside the 85th percentile", () => {
    expect(formatInsightsSpread({ median: 2, p85: 30 })).toBe("2.0h median, 30.0h p85");
    expect(formatInsightsSpread({ median: null, p85: null })).toBe("-");
  });
});

describe("insightsSeries", () => {
  it("draws up to six series and folds the smallest into other beyond that", () => {
    const totals = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `c${index}`, total: index + 1 }));
    expect(insightsSeries(totals(6))).toEqual({
      shown: ["c5", "c4", "c3", "c2", "c1", "c0"],
      folded: [],
    });
    expect(insightsSeries(totals(7))).toEqual({
      shown: ["c6", "c5", "c4", "c3", "c2"],
      folded: ["c1", "c0"],
    });
    expect(insightsSeries([{ id: "idle", total: 0 }])).toEqual({ shown: [], folded: [] });
  });
});

describe("insightsJiraSeries", () => {
  const entry = (issueType: string, landedHours: number) => ({ issueType, landedHours });

  it("ranks issue types by hours and keeps unticketed last in the last color", () => {
    expect(
      insightsJiraSeries([entry("Unticketed", 9), entry("Bug", 2), entry("Story", 5)]),
    ).toEqual([
      { key: "Story", label: "Story", types: ["Story"], colorIndex: 0 },
      { key: "Bug", label: "Bug", types: ["Bug"], colorIndex: 1 },
      { key: "Unticketed", label: "Unticketed", types: ["Unticketed"], colorIndex: 5 },
    ]);
  });

  it("folds beyond five issue types into other and drops types without hours", () => {
    const series = insightsJiraSeries([
      ...["A", "B", "C", "D", "E", "F"].map((type, index) => entry(type, 10 - index)),
      entry("Idle", 0),
      entry("Unticketed", 1),
    ]);
    expect(series.map((line) => [line.label, line.colorIndex])).toEqual([
      ["A", 0],
      ["B", 1],
      ["C", 2],
      ["D", 3],
      ["Other", 4],
      ["Unticketed", 5],
    ]);
    expect(series[4]!.types).toEqual(["E", "F"]);
    expect(
      insightsJiraSeries(["A", "B", "C", "D", "E"].map((type) => entry(type, 1))).map(
        (line) => line.label,
      ),
    ).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("labels keys Jira has not described as an unknown type", () => {
    expect(insightsJiraTypeLabel("Unknown")).toBe("Unknown type");
    expect(insightsJiraTypeLabel("Unticketed")).toBe("Unticketed");
    expect(insightsJiraTypeLabel("Story")).toBe("Story");
  });
});

describe("insightsUnticketedShare", () => {
  it("is null for a week that landed nothing", () => {
    expect(insightsUnticketedShare({ landedHours: 4, unticketedHours: 1 })).toBe(0.25);
    expect(insightsUnticketedShare({ landedHours: 0, unticketedHours: 0 })).toBeNull();
  });
});

describe("formatInsightsHoursOf", () => {
  it("shows hours with their share of the total", () => {
    expect(formatInsightsHoursOf(2, 8)).toBe("2.0h · 25%");
    expect(formatInsightsHoursOf(0, 0)).toBe("0.0h · -");
  });
});
