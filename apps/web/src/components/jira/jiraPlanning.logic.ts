import { jiraProjectKeyOf } from "@t3tools/client-runtime/state/jira";
import type {
  JiraIssueSummary,
  JiraProjectSprint,
  JiraSetSprintResult,
  JiraSprintState,
} from "@t3tools/contracts";

/** What `jira.sprints` and `jira.velocity` accept as a project key. */
const JIRA_PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]+$/;

/** The most issues one `jira.setSprint` call takes. */
export const JIRA_SET_SPRINT_MAX_KEYS = 50;

/** The most story points the server accepts on one issue. */
const JIRA_STORY_POINTS_MAX = 10_000;

/** A project key as typed, upper-cased; null when Jira would not accept it. */
export function normalizeJiraProjectKey(text: string | null | undefined): string | null {
  const key = text?.trim().toUpperCase() ?? "";
  return JIRA_PROJECT_KEY_PATTERN.test(key) ? key : null;
}

/** The project every issue belongs to, or null when they span several or there are none. */
export function sharedJiraProjectKey(issues: ReadonlyArray<Pick<JiraIssueSummary, "key">>) {
  const keys = new Set(issues.map((issue) => jiraProjectKeyOf(issue.key)));
  const [only] = keys;
  return keys.size === 1 && only !== undefined ? normalizeJiraProjectKey(only) : null;
}

// The project key is validated against the pattern above, so quoting it is all the escaping it
// needs; sprint ids are numbers. Nothing user-typed reaches the JQL otherwise.
export function jiraSprintSectionJql(projectKey: string, sprintId: number): string {
  return `project = "${projectKey}" AND sprint = ${sprintId} ORDER BY Rank`;
}

export function jiraBacklogJql(projectKey: string): string {
  return `project = "${projectKey}" AND sprint is EMPTY AND statusCategory != Done ORDER BY Rank`;
}

export type JiraPlanningSection =
  | { readonly id: string; readonly kind: "sprint"; readonly sprint: JiraProjectSprint }
  | { readonly id: "backlog"; readonly kind: "backlog" };

/** Active sprints, then future ones, then the backlog. Closed sprints are not planned into. */
export function jiraPlanningSections(
  sprints: ReadonlyArray<JiraProjectSprint>,
): ReadonlyArray<JiraPlanningSection> {
  const byState = (state: JiraSprintState) =>
    sprints
      .filter((sprint) => sprint.state === state)
      .map((sprint): JiraPlanningSection => ({
        id: `sprint:${sprint.id}`,
        kind: "sprint",
        sprint,
      }));
  return [...byState("active"), ...byState("future"), { id: "backlog", kind: "backlog" }];
}

export type JiraMoveTarget = {
  readonly sprintId: number | null;
  readonly label: string;
  readonly state: JiraSprintState | null;
};

/** Every open sprint, then the backlog, which is always offered so a move can be undone. */
export function jiraMoveTargets(
  sprints: ReadonlyArray<JiraProjectSprint>,
): ReadonlyArray<JiraMoveTarget> {
  return [
    ...jiraPlanningSections(sprints).flatMap((section) =>
      section.kind === "sprint"
        ? [{ sprintId: section.sprint.id, label: section.sprint.name, state: section.sprint.state }]
        : [],
    ),
    { sprintId: null, label: "Backlog", state: null },
  ];
}

/** Points on the loaded rows, and how many of them carry an estimate. */
export function jiraStoryPointsTotal(
  issues: ReadonlyArray<Pick<JiraIssueSummary, "storyPoints">>,
): { readonly points: number; readonly estimated: number } {
  let points = 0;
  let estimated = 0;
  for (const issue of issues) {
    if (issue.storyPoints === null) continue;
    points += issue.storyPoints;
    estimated += 1;
  }
  return { points, estimated };
}

/** Rounded so fractional estimates do not show float noise. */
export function formatJiraPoints(points: number): string {
  return String(Math.round(points * 100) / 100);
}

/** A section's total; with unloaded pages it is only a lower bound. */
export function formatJiraPointsTotal(points: number, morePages: boolean): string {
  return `${morePages ? "≥ " : ""}${formatJiraPoints(points)} pt`;
}

export type JiraStoryPointsInput =
  | { readonly ok: true; readonly storyPoints: number | null }
  | { readonly ok: false; readonly message: string };

/** An emptied field clears the estimate; anything but a plain non-negative number is refused. */
export function parseJiraStoryPointsInput(text: string): JiraStoryPointsInput {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, storyPoints: null };
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) {
    return { ok: false, message: "Story points must be a number of zero or more." };
  }
  const storyPoints = Number(trimmed);
  if (!Number.isFinite(storyPoints) || storyPoints > JIRA_STORY_POINTS_MAX) {
    return { ok: false, message: `Story points must be at most ${JIRA_STORY_POINTS_MAX}.` };
  }
  return { ok: true, storyPoints };
}

export function chunkJiraKeys(
  keys: ReadonlyArray<string>,
  size: number = JIRA_SET_SPRINT_MAX_KEYS,
): ReadonlyArray<ReadonlyArray<string>> {
  const chunks: string[][] = [];
  for (let start = 0; start < keys.length; start += size) {
    chunks.push(keys.slice(start, start + size));
  }
  return chunks;
}

/**
 * One move's outcome over all its chunks. A chunk that failed as a whole, such as a refused
 * token, counts each of its keys as failed with that chunk's message.
 */
export function mergeJiraSetSprintOutcomes(
  outcomes: ReadonlyArray<
    | { readonly ok: true; readonly result: JiraSetSprintResult }
    | { readonly ok: false; readonly keys: ReadonlyArray<string>; readonly message: string }
  >,
): JiraSetSprintResult {
  return {
    updated: outcomes.flatMap((outcome) => (outcome.ok ? outcome.result.updated : [])),
    failed: outcomes.flatMap((outcome) =>
      outcome.ok
        ? outcome.result.failed
        : outcome.keys.map((key) => ({ key, message: outcome.message })),
    ),
  };
}
