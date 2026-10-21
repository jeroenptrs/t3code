import type { JiraProjectSprint } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  chunkJiraKeys,
  formatJiraPointsTotal,
  jiraBacklogJql,
  jiraMoveTargets,
  jiraPlanningSections,
  jiraSprintSectionJql,
  jiraStoryPointsTotal,
  mergeJiraSetSprintOutcomes,
  normalizeJiraProjectKey,
  parseJiraStoryPointsInput,
  sharedJiraProjectKey,
} from "./jiraPlanning.logic";

const sprint = (
  id: number,
  state: JiraProjectSprint["state"],
  name = `Sprint ${id}`,
): JiraProjectSprint => ({
  id,
  name,
  state,
  startDate: null,
  endDate: null,
  completeDate: null,
});

describe("normalizeJiraProjectKey", () => {
  it("upper-cases a typed key and refuses what Jira would not accept", () => {
    expect(normalizeJiraProjectKey(" abc ")).toBe("ABC");
    expect(normalizeJiraProjectKey("MY_PROJ2")).toBe("MY_PROJ2");
    expect(normalizeJiraProjectKey("A")).toBeNull();
    expect(normalizeJiraProjectKey("1AB")).toBeNull();
    expect(normalizeJiraProjectKey('AB" OR project = "X')).toBeNull();
    expect(normalizeJiraProjectKey(null)).toBeNull();
  });
});

describe("sharedJiraProjectKey", () => {
  it("names the project only when every issue is in it", () => {
    expect(sharedJiraProjectKey([{ key: "ABC-1" }, { key: "ABC-22" }])).toBe("ABC");
    expect(sharedJiraProjectKey([{ key: "ABC-1" }, { key: "XYZ-2" }])).toBeNull();
    expect(sharedJiraProjectKey([])).toBeNull();
  });
});

describe("planning JQL", () => {
  it("reads a sprint and the open backlog in rank order", () => {
    expect(jiraSprintSectionJql("ABC", 42)).toBe('project = "ABC" AND sprint = 42 ORDER BY Rank');
    expect(jiraBacklogJql("ABC")).toBe(
      'project = "ABC" AND sprint is EMPTY AND statusCategory != Done ORDER BY Rank',
    );
  });
});

describe("jiraPlanningSections", () => {
  it("puts active sprints before future ones and ends with the backlog", () => {
    const sections = jiraPlanningSections([
      sprint(3, "future"),
      sprint(1, "active"),
      sprint(9, "closed"),
      sprint(4, "future"),
    ]);
    expect(sections.map((section) => section.id)).toEqual([
      "sprint:1",
      "sprint:3",
      "sprint:4",
      "backlog",
    ]);
  });
});

describe("jiraMoveTargets", () => {
  it("offers every open sprint and always the backlog", () => {
    expect(jiraMoveTargets([sprint(2, "future", "Next"), sprint(1, "active", "Now")])).toEqual([
      { sprintId: 1, label: "Now", state: "active" },
      { sprintId: 2, label: "Next", state: "future" },
      { sprintId: null, label: "Backlog", state: null },
    ]);
    expect(jiraMoveTargets([])).toEqual([{ sprintId: null, label: "Backlog", state: null }]);
  });
});

describe("story points totals", () => {
  it("sums estimated rows and marks a total with unloaded pages as a lower bound", () => {
    const total = jiraStoryPointsTotal([
      { storyPoints: 0.1 },
      { storyPoints: null },
      { storyPoints: 0.2 },
      { storyPoints: 3 },
    ]);
    expect(total.estimated).toBe(3);
    expect(formatJiraPointsTotal(total.points, false)).toBe("3.3 pt");
    expect(formatJiraPointsTotal(total.points, true)).toBe("≥ 3.3 pt");
  });
});

describe("parseJiraStoryPointsInput", () => {
  it("accepts non-negative numbers and clears on an empty field", () => {
    expect(parseJiraStoryPointsInput(" 5 ")).toEqual({ ok: true, storyPoints: 5 });
    expect(parseJiraStoryPointsInput("0.5")).toEqual({ ok: true, storyPoints: 0.5 });
    expect(parseJiraStoryPointsInput(".5")).toEqual({ ok: true, storyPoints: 0.5 });
    expect(parseJiraStoryPointsInput("0")).toEqual({ ok: true, storyPoints: 0 });
    expect(parseJiraStoryPointsInput("  ")).toEqual({ ok: true, storyPoints: null });
  });

  it("refuses negatives, words and values past the server's limit", () => {
    for (const text of ["-1", "abc", "1e3", "3 pt", "Infinity", "10001"]) {
      expect(parseJiraStoryPointsInput(text).ok).toBe(false);
    }
  });
});

describe("chunkJiraKeys", () => {
  it("splits a selection into calls of at most fifty keys", () => {
    const keys = Array.from({ length: 120 }, (_, index) => `ABC-${index + 1}`);
    expect(chunkJiraKeys(keys).map((chunk) => chunk.length)).toEqual([50, 50, 20]);
    expect(chunkJiraKeys([])).toEqual([]);
  });
});

describe("mergeJiraSetSprintOutcomes", () => {
  it("keeps per-issue refusals and fails every key of a chunk that failed whole", () => {
    expect(
      mergeJiraSetSprintOutcomes([
        {
          ok: true,
          result: { updated: ["ABC-1"], failed: [{ key: "ABC-2", message: "No permission" }] },
        },
        { ok: false, keys: ["ABC-3", "ABC-4"], message: "Token rejected" },
      ]),
    ).toEqual({
      updated: ["ABC-1"],
      failed: [
        { key: "ABC-2", message: "No permission" },
        { key: "ABC-3", message: "Token rejected" },
        { key: "ABC-4", message: "Token rejected" },
      ],
    });
  });
});
