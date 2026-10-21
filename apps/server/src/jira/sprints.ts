import type { JiraProjectSprint, JiraSprintVelocity } from "@t3tools/contracts";

import type { JiraRawSuggestion } from "./JiraApi.ts";

/**
 * Project sprints and velocity without the Agile API, which scoped tokens cannot call. Sprints
 * come from issues' sprint fields, which carry state and dates, and from JQL autocomplete, which
 * also lists empty sprints but nothing about them beyond id and name.
 */

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/**
 * One autocomplete suggestion as a sprint. Jira wraps the matched text in `<b>` and appends
 * ` (<id>)` to the name; null when the value is not a sprint id.
 */
export const parseSprintSuggestion = (
  suggestion: JiraRawSuggestion,
): { readonly id: number; readonly name: string } | null => {
  const value = suggestion.value.trim();
  if (!/^\d+$/.test(value)) return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const text = suggestion.displayName
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
  const trailingId = /\s*\((\d+)\)\s*$/.exec(text);
  const name = (
    trailingId !== null && Number(trailingId[1]) === id ? text.slice(0, trailingId.index) : text
  ).trim();
  return name.length === 0 ? null : { id, name };
};

/**
 * What to ask autocomplete for: the project key, then the names of the project's known sprints
 * without their trailing number ("Team Phoenix 23" → "Team Phoenix"), since teams number sprints
 * under one name. A bare "Sprint" is skipped: it would match every team's sprints on the site.
 * Distinct, and capped because each is a request.
 */
export const sprintSuggestionPrefixes = (
  projectKey: string,
  known: ReadonlyArray<{ readonly name: string }>,
  limit: number,
): ReadonlyArray<string> =>
  [
    ...new Set(
      [projectKey, ...known.map((sprint) => sprint.name.replace(/\s*\d+\s*$/, "").trim())].filter(
        (prefix) => prefix.length > 0 && prefix.toLowerCase() !== "sprint",
      ),
    ),
  ].slice(0, limit);

const STATE_ORDER = { active: 0, future: 1, closed: 2 } as const;

const timeOrNull = (iso: string | null) => {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * The project's open sprints: active first, then future, each by start date (unknown last) and
 * then id. A sprint seen on an issue keeps its state and dates; one only autocomplete knows is
 * taken as future, with no dates.
 */
export const mergeProjectSprints = (
  fromIssues: ReadonlyArray<JiraProjectSprint>,
  fromSuggestions: ReadonlyArray<{ readonly id: number; readonly name: string }>,
): Array<JiraProjectSprint> => {
  const byId = new Map<number, JiraProjectSprint>();
  for (const sprint of fromIssues) {
    if (!byId.has(sprint.id)) byId.set(sprint.id, sprint);
  }
  for (const { id, name } of fromSuggestions) {
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        name,
        state: "future",
        startDate: null,
        endDate: null,
        completeDate: null,
      });
    }
  }
  return [...byId.values()]
    .filter((sprint) => sprint.state !== "closed")
    .toSorted((a, b) => {
      const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state];
      if (byState !== 0) return byState;
      const aStart = timeOrNull(a.startDate);
      const bStart = timeOrNull(b.startDate);
      if (aStart !== bStart) {
        if (aStart === null) return 1;
        if (bStart === null) return -1;
        return aStart - bStart;
      }
      return a.id - b.id;
    });
};

export interface JiraVelocityRow {
  readonly sprints: ReadonlyArray<JiraProjectSprint>;
  readonly storyPoints: number | null;
  readonly resolutionDate: string | null;
}

/** When a closed sprint ended, as far as its dates tell. */
const completedAt = (sprint: JiraProjectSprint) =>
  timeOrNull(sprint.completeDate) ?? timeOrNull(sprint.endDate);

/**
 * Committed and completed points for the `lastN` most recently completed sprints. An issue
 * counts toward every closed sprint its sprint field lists, so a carried-over issue is committed
 * in each, and completed in a sprint only when it was resolved by the time that sprint completed.
 */
export const aggregateVelocity = (
  rows: ReadonlyArray<JiraVelocityRow>,
  lastN: number,
): {
  readonly sprints: ReadonlyArray<JiraSprintVelocity>;
  readonly averageCompletedPoints: number | null;
} => {
  const bySprint = new Map<number, JiraSprintVelocity>();
  for (const row of rows) {
    const points = row.storyPoints ?? 0;
    const resolvedAt = timeOrNull(row.resolutionDate);
    const counted = new Set<number>();
    for (const sprint of row.sprints) {
      if (sprint.state !== "closed" || counted.has(sprint.id)) continue;
      counted.add(sprint.id);
      const cutoff = completedAt(sprint);
      const completed = resolvedAt !== null && (cutoff === null || resolvedAt <= cutoff);
      const current = bySprint.get(sprint.id) ?? {
        sprint,
        committedPoints: 0,
        completedPoints: 0,
        issueCount: 0,
        completedIssueCount: 0,
      };
      bySprint.set(sprint.id, {
        sprint: current.sprint,
        committedPoints: current.committedPoints + points,
        completedPoints: current.completedPoints + (completed ? points : 0),
        issueCount: current.issueCount + 1,
        completedIssueCount: current.completedIssueCount + (completed ? 1 : 0),
      });
    }
  }
  const sprints = [...bySprint.values()]
    .toSorted((a, b) => {
      const aEnded = completedAt(a.sprint);
      const bEnded = completedAt(b.sprint);
      if (aEnded !== bEnded) {
        // An undated sprint goes after every dated one.
        if (aEnded === null) return 1;
        if (bEnded === null) return -1;
        return bEnded - aEnded;
      }
      return b.sprint.id - a.sprint.id;
    })
    .slice(0, lastN);
  return {
    sprints,
    averageCompletedPoints:
      sprints.length === 0
        ? null
        : sprints.reduce((sum, entry) => sum + entry.completedPoints, 0) / sprints.length,
  };
};
