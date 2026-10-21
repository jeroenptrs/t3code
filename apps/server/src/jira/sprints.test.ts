import type { JiraProjectSprint } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  aggregateVelocity,
  mergeProjectSprints,
  parseSprintSuggestion,
  sprintSuggestionPrefixes,
} from "./sprints.ts";

const sprint = (
  id: number,
  state: JiraProjectSprint["state"],
  dates: Partial<Pick<JiraProjectSprint, "startDate" | "endDate" | "completeDate">> = {},
): JiraProjectSprint => ({
  id,
  name: `Sprint ${id}`,
  state,
  startDate: null,
  endDate: null,
  completeDate: null,
  ...dates,
});

describe("parseSprintSuggestion", () => {
  it("strips Jira's highlighting, entities and the trailing id", () => {
    expect(
      parseSprintSuggestion({ value: "42", displayName: "<b>ABC</b> R&amp;D &quot;Q4&quot; (42)" }),
    ).toEqual({ id: 42, name: 'ABC R&D "Q4"' });
    expect(
      parseSprintSuggestion({ value: "7", displayName: "Tom&#39;s &lt;b&gt; sprint (7)" }),
    ).toEqual({ id: 7, name: "Tom's <b> sprint" });
  });

  it("keeps a trailing number in parentheses that is not the id", () => {
    expect(parseSprintSuggestion({ value: "42", displayName: "<b>Team</b> Phoenix (3)" })).toEqual({
      id: 42,
      name: "Team Phoenix (3)",
    });
  });

  it("rejects values that are not sprint ids", () => {
    for (const value of ["", "abc", "0", "-3", "1.5", "99999999999999999999"]) {
      expect(parseSprintSuggestion({ value, displayName: "Sprint" })).toBeNull();
    }
    expect(parseSprintSuggestion({ value: "5", displayName: "<b></b> (5)" })).toBeNull();
  });
});

describe("sprintSuggestionPrefixes", () => {
  it("asks for the project key, then each sprint name without its number, never a bare Sprint", () => {
    expect(
      sprintSuggestionPrefixes(
        "ABC",
        [
          { name: "Team Phoenix 23" },
          { name: "Team Phoenix 24" },
          { name: "42" },
          { name: "Sprint 7" },
          { name: "Q4" },
        ],
        3,
      ),
    ).toEqual(["ABC", "Team Phoenix", "Q"]);
  });
});

describe("mergeProjectSprints", () => {
  it("keeps issue-known sprints, adds suggestion-only ones as future, and drops closed", () => {
    const merged = mergeProjectSprints(
      [
        sprint(5, "future", { startDate: "2026-11-02T00:00:00.000Z" }),
        sprint(3, "closed"),
        sprint(4, "active", { startDate: "2026-10-19T00:00:00.000Z" }),
        sprint(6, "future", { startDate: "2026-10-26T00:00:00.000Z" }),
      ],
      [
        { id: 4, name: "Renamed in autocomplete" },
        { id: 3, name: "Sprint 3" },
        { id: 9, name: "Empty sprint" },
        { id: 8, name: "Another empty" },
      ],
    );
    expect(merged.map(({ id, state, name }) => ({ id, state, name }))).toEqual([
      { id: 4, state: "active", name: "Sprint 4" },
      { id: 6, state: "future", name: "Sprint 6" },
      { id: 5, state: "future", name: "Sprint 5" },
      { id: 8, state: "future", name: "Another empty" },
      { id: 9, state: "future", name: "Empty sprint" },
    ]);
    expect(merged.at(-1)).toEqual({
      id: 9,
      name: "Empty sprint",
      state: "future",
      startDate: null,
      endDate: null,
      completeDate: null,
    });
  });
});

describe("aggregateVelocity", () => {
  const first = sprint(1, "closed", {
    endDate: "2026-09-14T00:00:00.000Z",
    completeDate: "2026-09-15T00:00:00.000Z",
  });
  const second = sprint(2, "closed", {
    endDate: "2026-09-28T00:00:00.000Z",
    completeDate: "2026-09-29T00:00:00.000Z",
  });
  const open = sprint(3, "active");

  it("commits a carried-over issue in both sprints and completes it only where it resolved", () => {
    const result = aggregateVelocity(
      [
        // Carried over from sprint 1 and resolved in sprint 2.
        {
          sprints: [first, second],
          storyPoints: 5,
          resolutionDate: "2026-09-20T00:00:00.000Z",
        },
        { sprints: [first], storyPoints: 3, resolutionDate: "2026-09-10T00:00:00.000Z" },
        { sprints: [second, open], storyPoints: null, resolutionDate: "2026-09-21T00:00:00.000Z" },
        { sprints: [second, open], storyPoints: 2, resolutionDate: null },
      ],
      6,
    );
    expect(result.sprints).toEqual([
      {
        sprint: second,
        committedPoints: 7,
        completedPoints: 5,
        issueCount: 3,
        completedIssueCount: 2,
      },
      {
        sprint: first,
        committedPoints: 8,
        completedPoints: 3,
        issueCount: 2,
        completedIssueCount: 1,
      },
    ]);
    expect(result.averageCompletedPoints).toBe(4);
  });

  it("keeps the last N completed sprints and falls back to end date, then resolution", () => {
    const noComplete = sprint(4, "closed", { endDate: "2026-10-12T00:00:00.000Z" });
    const undated = sprint(5, "closed");
    const result = aggregateVelocity(
      [
        { sprints: [first], storyPoints: 1, resolutionDate: "2026-09-01T00:00:00.000Z" },
        { sprints: [second], storyPoints: 2, resolutionDate: "2026-09-01T00:00:00.000Z" },
        // Resolved after the end date: not completed in that sprint.
        { sprints: [noComplete], storyPoints: 8, resolutionDate: "2026-10-13T00:00:00.000Z" },
        { sprints: [undated], storyPoints: 13, resolutionDate: "2027-01-01T00:00:00.000Z" },
      ],
      2,
    );
    expect(result.sprints.map((entry) => [entry.sprint.id, entry.completedPoints])).toEqual([
      [4, 0],
      [2, 2],
    ]);
    expect(result.averageCompletedPoints).toBe(1);
    expect(
      aggregateVelocity(
        [{ sprints: [undated], storyPoints: 13, resolutionDate: "2027-01-01T00:00:00.000Z" }],
        6,
      ).sprints[0]?.completedPoints,
    ).toBe(13);
  });

  it("has no average without closed sprints", () => {
    expect(
      aggregateVelocity([{ sprints: [open], storyPoints: 3, resolutionDate: null }], 6),
    ).toEqual({ sprints: [], averageCompletedPoints: null });
  });
});
