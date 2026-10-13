import type {
  JiraComment,
  JiraFilterView,
  JiraIssueSummary,
  JiraSprint,
  JiraStatusCategory,
  JiraTransition,
  JiraUser,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { adfToMarkdown } from "./adfToMarkdown.ts";
import type {
  JiraRawComment,
  JiraRawField,
  JiraRawFilter,
  JiraRawIssue,
  JiraRawTransition,
} from "./JiraApi.ts";

/** Custom field ids differ per site; null when the site has no such field. */
export interface JiraFieldIds {
  readonly sprint: string | null;
  readonly storyPoints: string | null;
}

const SPRINT_FIELD_TYPE = "com.pyxis.greenhopper.jira:gh-sprint";
const STORY_POINTS_FIELD_TYPE = "com.pyxis.greenhopper.jira:jsw-story-points";
const FLOAT_FIELD_TYPE = "com.atlassian.jira.plugin.system.customfieldtypes:float";

/** Fields a row needs, before the site's sprint and story point field ids. */
const SUMMARY_FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "updated"];

export const summaryFields = (ids: JiraFieldIds): ReadonlyArray<string> => [
  ...SUMMARY_FIELDS,
  ...(ids.sprint === null ? [] : [ids.sprint]),
  ...(ids.storyPoints === null ? [] : [ids.storyPoints]),
];

/**
 * Finds the sprint and story point fields from `GET /rest/api/3/field`. Team-managed projects
 * use "Story point estimate" and company-managed ones "Story Points"; the former wins.
 */
export const resolveFieldIds = (fields: ReadonlyArray<JiraRawField>): JiraFieldIds => {
  const sprint = fields.find((field) => field.schema?.custom === SPRINT_FIELD_TYPE);
  const floatNamed = (name: string) =>
    fields.find(
      (field) =>
        field.schema?.custom === FLOAT_FIELD_TYPE &&
        field.name?.trim().toLowerCase() === name.toLowerCase(),
    );
  const storyPoints =
    floatNamed("Story point estimate") ??
    fields.find((field) => field.schema?.custom === STORY_POINTS_FIELD_TYPE) ??
    floatNamed("Story Points");
  return { sprint: sprint?.id ?? null, storyPoints: storyPoints?.id ?? null };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOrNull = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

/** Jira writes offsets as `+0000`; clients get a strict ISO string. */
export const toIsoDateTime = (value: unknown): string | null =>
  typeof value === "string"
    ? Option.getOrNull(Option.map(DateTime.make(value), DateTime.formatIso))
    : null;

/** Workflows differ per project, so only the status category is generic. */
const toStatusCategory = (key: unknown): JiraStatusCategory => {
  switch (key) {
    case "indeterminate":
      return "in-progress";
    case "done":
      return "done";
    default:
      return "todo";
  }
};

export const toJiraUser = (user: unknown): JiraUser | null => {
  if (!isRecord(user)) return null;
  const accountId = stringOrNull(user.accountId);
  if (accountId === null) return null;
  const avatars = isRecord(user.avatarUrls) ? user.avatarUrls : {};
  return {
    accountId,
    displayName: typeof user.displayName === "string" ? user.displayName : "",
    avatarUrl: stringOrNull(avatars["48x48"]) ?? stringOrNull(avatars["32x32"]),
  };
};

const SPRINT_STATES = new Set(["active", "future", "closed"]);

/** Sprint objects in field order. Legacy string-encoded sprints and anything malformed are skipped. */
const toSprints = (value: unknown): Array<JiraSprint> =>
  (Array.isArray(value) ? value : []).flatMap((sprint): Array<JiraSprint> => {
    if (!isRecord(sprint)) return [];
    const state = typeof sprint.state === "string" ? sprint.state.toLowerCase() : "";
    if (
      typeof sprint.id !== "number" ||
      !Number.isInteger(sprint.id) ||
      sprint.id <= 0 ||
      typeof sprint.name !== "string" ||
      !SPRINT_STATES.has(state)
    ) {
      return [];
    }
    return [{ id: sprint.id, name: sprint.name, state: state as JiraSprint["state"] }];
  });

const nameOf = (value: unknown) => (isRecord(value) ? stringOrNull(value.name) : null);

/** The issue's page on its site. */
export const browseUrl = (site: string, key: string) => `https://${site}/browse/${key}`;

/** One raw issue as a row. `site` is the lowercase host the issue was read from. */
export const toIssueSummary = (
  issue: JiraRawIssue,
  context: { readonly site: string; readonly fieldIds: JiraFieldIds },
): JiraIssueSummary => {
  const fields = issue.fields ?? {};
  const status = isRecord(fields.status) ? fields.status : {};
  const storyPoints =
    context.fieldIds.storyPoints === null ? null : fields[context.fieldIds.storyPoints];
  return {
    site: context.site,
    key: issue.key,
    url: browseUrl(context.site, issue.key),
    summary: typeof fields.summary === "string" ? fields.summary : "",
    status: typeof status.name === "string" ? status.name : "",
    statusCategory: toStatusCategory(
      isRecord(status.statusCategory) ? status.statusCategory.key : undefined,
    ),
    issueType: nameOf(fields.issuetype),
    priority: nameOf(fields.priority),
    assignee: toJiraUser(fields.assignee),
    sprints: context.fieldIds.sprint === null ? [] : toSprints(fields[context.fieldIds.sprint]),
    storyPoints:
      typeof storyPoints === "number" && Number.isFinite(storyPoints) ? storyPoints : null,
    updated: toIsoDateTime(fields.updated),
  };
};

/** Null when the description is absent or converts to nothing. */
export const toDescription = (issue: JiraRawIssue): string | null => {
  const description = issue.fields?.description;
  if (description === null || description === undefined) return null;
  const markdown = adfToMarkdown(description).trim();
  return markdown.length > 0 ? markdown : null;
};

export const toComment = (comment: JiraRawComment): JiraComment | null => {
  const created = toIsoDateTime(comment.created);
  if (created === null || comment.id.trim().length === 0) return null;
  return {
    id: comment.id,
    author: toJiraUser(comment.author),
    body: comment.body === undefined || comment.body === null ? "" : adfToMarkdown(comment.body),
    created,
    updated: toIsoDateTime(comment.updated),
  };
};

export const toTransition = (transition: JiraRawTransition): JiraTransition => ({
  id: transition.id,
  name: transition.name,
  toStatus: transition.to?.name ?? transition.name,
  toStatusCategory: toStatusCategory(transition.to?.statusCategory?.key),
});

export const toFilterView = (filter: JiraRawFilter, site: string): JiraFilterView => ({
  site,
  id: filter.id,
  name: filter.name,
  jql: filter.jql ?? "",
  owner: stringOrNull(filter.owner?.displayName),
  favourite: filter.favourite ?? false,
  url: `https://${site}/issues/?filter=${encodeURIComponent(filter.id)}`,
});
