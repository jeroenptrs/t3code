import type {
  JiraIssueSummary,
  TriggerEvent,
  TriggerJiraEventPayload,
  TriggerJiraEventType,
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
  const before = new Set(previous.labels);
  const after = new Set(current.labels);
  const addedLabels = current.labels.filter((label) => !before.has(label));
  const removedLabels = previous.labels.filter((label) => !after.has(label));

  const types: Array<TriggerJiraEventType> = [];
  if (previous.status !== current.status) types.push("issue.status_changed");
  if (addedLabels.length > 0 || removedLabels.length > 0) types.push("issue.labels_changed");
  if ((previous.assignee?.accountId ?? null) !== (current.assignee?.accountId ?? null)) {
    types.push("issue.assignee_changed");
  }

  const fields: Omit<TriggerJiraEventPayload, "type"> = {
    site: current.site,
    key: current.key,
    projectKey: current.key.split("-")[0] ?? current.key,
    url: current.url,
    summary: current.summary,
    status: current.status,
    statusCategory: current.statusCategory,
    previousStatus: previous.status,
    previousStatusCategory: previous.statusCategory,
    issueType: current.issueType,
    priority: current.priority,
    assignee: current.assignee?.displayName ?? null,
    assigneeAccountId: current.assignee?.accountId ?? null,
    previousAssigneeAccountId: previous.assignee?.accountId ?? null,
    labels: current.labels,
    addedLabels,
    removedLabels,
  };
  return types.map((type) => ({
    source: "jira",
    type,
    occurredAt,
    payload: { type, ...fields },
  }));
}
