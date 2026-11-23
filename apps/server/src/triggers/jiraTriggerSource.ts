import type {
  JiraIssueSummary,
  ScheduledTaskId,
  TriggerEvent,
  TriggerFilter,
  TriggerJiraEventPayload,
  TriggerJiraEventType,
  TriggerJiraQueryEventType,
} from "@t3tools/contracts";

/** The observation and event key of one issue. */
export const jiraTriggerKey = (site: string, key: string) => `${site}\u0000${key}`;

/** The issue changes since `previous`, as trigger events. The first observation raises none. */
export function diffJiraIssue(
  previous: JiraIssueSummary | null,
  current: JiraIssueSummary,
  occurredAt: string,
): ReadonlyArray<TriggerEvent> {
  if (previous === null) return [];
  const { addedLabels, removedLabels } = labelChanges(previous, current);
  const types: Array<TriggerJiraEventType> = [];
  if (previous.status !== current.status) types.push("issue.status_changed");
  if (addedLabels.length > 0 || removedLabels.length > 0) types.push("issue.labels_changed");
  if ((previous.assignee?.accountId ?? null) !== (current.assignee?.accountId ?? null)) {
    types.push("issue.assignee_changed");
  }

  const fields = jiraPayloadFields(previous, current);
  return types.map((type) => ({
    source: "jira",
    type,
    occurredAt,
    payload: { type, ...fields },
  }));
}

function labelChanges(previous: JiraIssueSummary | null, current: JiraIssueSummary) {
  const before = new Set(previous?.labels ?? []);
  const after = new Set(current.labels);
  return {
    addedLabels: previous === null ? [] : current.labels.filter((label) => !before.has(label)),
    removedLabels: (previous?.labels ?? []).filter((label) => !after.has(label)),
  };
}

function jiraPayloadFields(
  previous: JiraIssueSummary | null,
  current: JiraIssueSummary,
): Omit<TriggerJiraEventPayload, "type"> {
  return {
    site: current.site,
    key: current.key,
    projectKey: current.key.split("-")[0] ?? current.key,
    url: current.url,
    summary: current.summary,
    status: current.status,
    statusCategory: current.statusCategory,
    previousStatus: previous?.status ?? null,
    previousStatusCategory: previous?.statusCategory ?? null,
    issueType: current.issueType,
    priority: current.priority,
    assignee: current.assignee?.displayName ?? null,
    assigneeAccountId: current.assignee?.accountId ?? null,
    previousAssigneeAccountId: previous?.assignee?.accountId ?? null,
    labels: current.labels,
    ...labelChanges(previous, current),
  };
}

/** The issue fields a Jira query trigger compares between polls. */
export type JiraQueryWatchedField =
  | "status"
  | "labels"
  | "assignee"
  | "priority"
  | "issueType"
  | "summary";

const FILTERABLE_FIELDS: ReadonlyArray<JiraQueryWatchedField> = [
  "priority",
  "issueType",
  "summary",
];

/** Status, labels, and assignee always; priority, issue type, and summary when a filter names them. */
export function jiraQueryWatchedFields(
  filters: ReadonlyArray<TriggerFilter>,
): ReadonlySet<JiraQueryWatchedField> {
  const named = new Set(filters.map((filter) => filter.path));
  return new Set<JiraQueryWatchedField>([
    "status",
    "labels",
    "assignee",
    ...FILTERABLE_FIELDS.filter((field) => named.has(`event.${field}`)),
  ]);
}

const changed: Record<
  JiraQueryWatchedField,
  (previous: JiraIssueSummary, current: JiraIssueSummary) => boolean
> = {
  status: (previous, current) => previous.status !== current.status,
  labels: (previous, current) => {
    const { addedLabels, removedLabels } = labelChanges(previous, current);
    return addedLabels.length > 0 || removedLabels.length > 0;
  },
  assignee: (previous, current) =>
    (previous.assignee?.accountId ?? null) !== (current.assignee?.accountId ?? null),
  priority: (previous, current) => previous.priority !== current.priority,
  issueType: (previous, current) => previous.issueType !== current.issueType,
  summary: (previous, current) => previous.summary !== current.summary,
};

const CHANGE_EVENT_TYPES = {
  status: "issue.status_changed",
  labels: "issue.labels_changed",
  assignee: "issue.assignee_changed",
} as const;

/**
 * One issue of a Jira query between two polls: null `previous` means it entered the result set,
 * null `current` that it left. A left issue reports its last seen state.
 */
export function diffJiraQueryIssue(
  previous: JiraIssueSummary | null,
  current: JiraIssueSummary | null,
  watched: ReadonlySet<JiraQueryWatchedField>,
  context: {
    readonly triggerId: ScheduledTaskId;
    readonly query: string;
    readonly occurredAt: string;
  },
): ReadonlyArray<Extract<TriggerEvent, { readonly source: "jira_query" }>> {
  let types: ReadonlyArray<TriggerJiraQueryEventType>;
  let changedFields: ReadonlyArray<JiraQueryWatchedField> = [];
  const shown = current ?? previous;
  if (shown === null) return [];
  if (previous === null) types = ["issue.entered"];
  else if (current === null) types = ["issue.left"];
  else {
    changedFields = [...watched].filter((field) => changed[field](previous, current));
    const updates: Array<TriggerJiraQueryEventType> = [];
    for (const field of changedFields) {
      if (field === "status" || field === "labels" || field === "assignee") {
        updates.push(CHANGE_EVENT_TYPES[field]);
      } else if (!updates.includes("issue.updated")) updates.push("issue.updated");
    }
    types = updates;
  }
  const fields = jiraPayloadFields(current === null ? null : previous, shown);
  return types.map((type) => ({
    source: "jira_query",
    type,
    triggerId: context.triggerId,
    occurredAt: context.occurredAt,
    payload: { type, ...fields, changedFields, query: context.query },
  }));
}

/** One entry of an issue's changelog, as `JiraApi.bulkChangelog` reads it. */
export interface JiraChangeHistory {
  /** ISO timestamp. */
  readonly created: string;
  readonly items: ReadonlyArray<{
    readonly field?: string | undefined;
    readonly fieldId?: string | undefined;
    readonly to?: string | null | undefined;
    readonly toString?: string | null | undefined;
  }>;
}

/** The fields `jiraQueryRoundTrips` replays from an issue's changelog. */
export const JIRA_ROUND_TRIP_FIELDS = ["labels", "status", "assignee"] as const;

export interface JiraQueryRoundTrip {
  readonly leftAt: string;
  readonly enteredAt: string;
}

/**
 * Times an issue seen in both polls left the query and came back between them, which the two
 * snapshots cannot show. Replays the changelog after `previous.updated` over `previous`, tracking
 * the labels, status, and assignee both snapshots share and the JQL names: the issue is out while
 * any tracked value is missing.
 */
export function jiraQueryRoundTrips(
  previous: JiraIssueSummary,
  current: JiraIssueSummary,
  histories: ReadonlyArray<JiraChangeHistory>,
  jql: string,
): ReadonlyArray<JiraQueryRoundTrip> {
  if (previous.updated === null) return [];
  const since = Date.parse(previous.updated);
  const named = (value: string) => jql.toLowerCase().includes(value.toLowerCase());
  const labels = previous.labels.filter((label) => current.labels.includes(label) && named(label));
  const status =
    previous.status === current.status && named(previous.status) ? previous.status : null;
  const previousAssignee = previous.assignee?.accountId ?? null;
  const assignee =
    previousAssignee !== null &&
    previousAssignee === (current.assignee?.accountId ?? null) &&
    named(previousAssignee)
      ? previousAssignee
      : null;
  if (labels.length === 0 && status === null && assignee === null) return [];

  const state = {
    labels: new Set(previous.labels),
    status: previous.status,
    assignee: previousAssignee,
  };
  const inside = () =>
    labels.every((label) => state.labels.has(label)) &&
    (status === null || state.status.toLowerCase() === status.toLowerCase()) &&
    (assignee === null || state.assignee === assignee);
  const ordered = histories
    .map((history) => ({ history, at: Date.parse(history.created) }))
    .filter(({ at }) => at > since)
    .toSorted((a, b) => a.at - b.at);

  const trips: Array<JiraQueryRoundTrip> = [];
  let leftAt: string | null = null;
  for (const { history } of ordered) {
    for (const item of history.items) {
      switch (item.fieldId ?? item.field) {
        case "labels":
          state.labels = new Set((item.toString ?? "").split(/\s+/).filter(Boolean));
          break;
        case "status":
          state.status = item.toString ?? "";
          break;
        case "assignee":
          state.assignee = item.to ?? null;
          break;
      }
    }
    const isInside = inside();
    if (leftAt === null && !isInside) leftAt = history.created;
    else if (leftAt !== null && isInside) {
      trips.push({ leftAt, enteredAt: history.created });
      leftAt = null;
    }
  }
  return trips;
}
