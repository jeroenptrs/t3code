import {
  JIRA_PROJECT_KEY_PATTERN,
  JIRA_SET_SPRINT_MAX_KEYS,
  JIRA_STORY_POINTS_MAX,
  jiraProjectKeyOf,
  type JiraIssueSummary,
  type JiraProjectSprint,
  type JiraSetSprintResult,
  type JiraSprintState,
} from "@t3tools/contracts";

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

// The project key is validated against JIRA_PROJECT_KEY_PATTERN, so quoting it is all the escaping
// it needs; sprint ids are numbers. Nothing user-typed reaches the JQL otherwise. Sub-tasks are
// left out, as Jira's own planning does: they follow their parent's sprint and cannot be moved alone.
export function jiraSprintSectionJql(projectKey: string, sprintId: number): string {
  return `project = "${projectKey}" AND sprint = ${sprintId} AND issuetype not in subTaskIssueTypes() ORDER BY Rank`;
}

// Jira keeps closed sprints in the sprint field, so an unfinished issue carried out of a closed
// sprint, or moved to the backlog after one, is in no open sprint rather than in none at all.
export function jiraBacklogJql(projectKey: string): string {
  return `project = "${projectKey}" AND (sprint is EMPTY OR sprint not in (openSprints(), futureSprints())) AND statusCategory != Done AND issuetype not in subTaskIssueTypes() ORDER BY Rank`;
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

export type JiraSetSprintChunkOutcome =
  | { readonly ok: true; readonly result: JiraSetSprintResult }
  | { readonly ok: false; readonly message: string };

export type JiraMoveOutcome = JiraSetSprintResult & {
  /** Every key sent, those of a chunk that failed whole included: Jira may have moved some. */
  readonly attempted: ReadonlyArray<string>;
  /** Why the move stopped early, when a chunk failed whole. */
  readonly stopped: string | null;
};

/**
 * Sends a move one chunk at a time. A chunk that fails whole, such as on a refused token, ends
 * the move, since the chunks after it would fail the same way.
 */
export async function sendJiraMove(
  keys: ReadonlyArray<string>,
  send: (chunk: ReadonlyArray<string>) => Promise<JiraSetSprintChunkOutcome>,
): Promise<JiraMoveOutcome> {
  const updated: string[] = [];
  const failed: JiraSetSprintResult["failed"][number][] = [];
  const attempted: string[] = [];
  for (const chunk of chunkJiraKeys(keys)) {
    attempted.push(...chunk);
    const outcome = await send(chunk);
    if (!outcome.ok) return { updated, failed, attempted, stopped: outcome.message };
    updated.push(...outcome.result.updated);
    failed.push(...outcome.result.failed);
  }
  return { updated, failed, attempted, stopped: null };
}
