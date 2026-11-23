import { assert, describe, it } from "@effect/vitest";
import { type JiraIssueSummary, ScheduledTaskId } from "@t3tools/contracts";

import {
  diffJiraIssue,
  diffJiraQueryIssue,
  jiraQueryRoundTrips,
  jiraQueryWatchedFields,
} from "./jiraTriggerSource.ts";

const AT = "2026-11-05T10:00:00.000Z";

const issue = (overrides: Partial<JiraIssueSummary> = {}): JiraIssueSummary => ({
  site: "acme.atlassian.net",
  key: "PROJ-12",
  url: "https://acme.atlassian.net/browse/PROJ-12",
  summary: "Fix login",
  status: "To Do",
  statusCategory: "todo",
  issueType: "Bug",
  parentKey: null,
  priority: "High",
  assignee: null,
  sprints: [],
  storyPoints: null,
  updated: null,
  labels: ["backend"],
  ...overrides,
});

const ada = { accountId: "acc-ada", displayName: "Ada", avatarUrl: null };

describe("diffJiraIssue", () => {
  it("raises nothing on the first observation", () => {
    assert.deepEqual(diffJiraIssue(null, issue(), AT), []);
  });

  it("raises nothing when nothing it watches changed", () => {
    assert.deepEqual(
      diffJiraIssue(issue(), issue({ summary: "Fix logout", updated: AT, priority: "Low" }), AT),
      [],
    );
  });

  it("raises a status change with the full payload", () => {
    const events = diffJiraIssue(
      issue(),
      issue({ status: "In Progress", statusCategory: "in-progress", assignee: ada }),
      AT,
    );
    assert.deepEqual(events, [
      {
        source: "jira",
        type: "issue.status_changed",
        occurredAt: AT,
        payload: {
          type: "issue.status_changed",
          site: "acme.atlassian.net",
          key: "PROJ-12",
          projectKey: "PROJ",
          url: "https://acme.atlassian.net/browse/PROJ-12",
          summary: "Fix login",
          status: "In Progress",
          statusCategory: "in-progress",
          previousStatus: "To Do",
          previousStatusCategory: "todo",
          issueType: "Bug",
          priority: "High",
          assignee: "Ada",
          assigneeAccountId: "acc-ada",
          previousAssigneeAccountId: null,
          labels: ["backend"],
          addedLabels: [],
          removedLabels: [],
        },
      },
      {
        source: "jira",
        type: "issue.assignee_changed",
        occurredAt: AT,
        payload: {
          type: "issue.assignee_changed",
          site: "acme.atlassian.net",
          key: "PROJ-12",
          projectKey: "PROJ",
          url: "https://acme.atlassian.net/browse/PROJ-12",
          summary: "Fix login",
          status: "In Progress",
          statusCategory: "in-progress",
          previousStatus: "To Do",
          previousStatusCategory: "todo",
          issueType: "Bug",
          priority: "High",
          assignee: "Ada",
          assigneeAccountId: "acc-ada",
          previousAssigneeAccountId: null,
          labels: ["backend"],
          addedLabels: [],
          removedLabels: [],
        },
      },
    ]);
  });

  it("raises a label change with added and removed labels, ignoring order", () => {
    assert.deepEqual(
      diffJiraIssue(issue({ labels: ["a", "b"] }), issue({ labels: ["b", "a"] }), AT),
      [],
    );
    const [event, ...rest] = diffJiraIssue(
      issue({ labels: ["backend", "stale"] }),
      issue({ labels: ["agent", "backend"] }),
      AT,
    );
    assert.deepEqual(rest, []);
    assert.equal(event?.type, "issue.labels_changed");
    assert.deepInclude(event?.payload, {
      labels: ["agent", "backend"],
      addedLabels: ["agent"],
      removedLabels: ["stale"],
    });
  });

  it("raises an assignee change when the assignee is removed", () => {
    const [event] = diffJiraIssue(issue({ assignee: ada }), issue(), AT);
    assert.equal(event?.type, "issue.assignee_changed");
    assert.deepInclude(event?.payload, {
      assignee: null,
      assigneeAccountId: null,
      previousAssigneeAccountId: "acc-ada",
    });
  });
});

describe("diffJiraQueryIssue", () => {
  const context = {
    triggerId: ScheduledTaskId.make("task:query"),
    query: "project = PROJ",
    occurredAt: AT,
  };
  const watched = jiraQueryWatchedFields([
    { path: "event.priority", op: "equals", value: "Highest" },
    { path: "event.status", op: "exists" },
  ]);
  const types = (events: ReturnType<typeof diffJiraQueryIssue>) =>
    events.map((event) => [event.type, event.payload.changedFields]);

  it("watches status, labels, assignee, and the issue fields filters name", () => {
    assert.deepEqual([...watched], ["status", "labels", "assignee", "priority"]);
  });

  it("raises entered and left with the trigger's id", () => {
    const [entered] = diffJiraQueryIssue(null, issue(), watched, context);
    assert.deepInclude(entered, {
      source: "jira_query",
      type: "issue.entered",
      triggerId: context.triggerId,
    });
    assert.deepInclude(entered?.payload, {
      key: "PROJ-12",
      previousStatus: null,
      query: "project = PROJ",
      changedFields: [],
    });
    const [left] = diffJiraQueryIssue(issue({ status: "Done" }), null, watched, context);
    assert.deepInclude(left, { type: "issue.left", triggerId: context.triggerId });
    assert.deepInclude(left?.payload, { status: "Done", previousStatus: null });
  });

  it("raises a status change and a watched field as updated, naming what changed", () => {
    assert.deepEqual(
      types(
        diffJiraQueryIssue(
          issue(),
          issue({ status: "In Progress", priority: "Highest" }),
          watched,
          context,
        ),
      ),
      [
        ["issue.status_changed", ["status", "priority"]],
        ["issue.updated", ["status", "priority"]],
      ],
    );
  });

  it("raises nothing for a change to a field no filter names", () => {
    assert.deepEqual(
      diffJiraQueryIssue(
        issue(),
        issue({ summary: "Fix logout", issueType: "Story" }),
        watched,
        context,
      ),
      [],
    );
  });
});

describe("jiraQueryRoundTrips", () => {
  const before = issue({ labels: ["backend", "needs-review"], updated: AT });
  const after = issue({ labels: ["backend", "needs-review"], updated: "2026-11-05T10:20:00.000Z" });
  const labels = (created: string, toString: string) => ({
    created,
    items: [{ fieldId: "labels", toString }],
  });
  const status = (created: string, toString: string) => ({
    created,
    items: [{ fieldId: "status", toString }],
  });
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly jql: string;
    readonly histories: Parameters<typeof jiraQueryRoundTrips>[2];
    readonly previous?: JiraIssueSummary;
    readonly expected: ReturnType<typeof jiraQueryRoundTrips>;
  }> = [
    {
      name: "a label the JQL names, removed and added back",
      jql: "labels = Needs-Review",
      histories: [
        labels("2026-11-05T10:15:00.000Z", "backend needs-review"),
        labels("2026-11-05T10:05:00.000Z", "backend"),
      ],
      expected: [{ leftAt: "2026-11-05T10:05:00.000Z", enteredAt: "2026-11-05T10:15:00.000Z" }],
    },
    {
      name: "a label the JQL does not name",
      jql: "labels = needs-review",
      histories: [
        labels("2026-11-05T10:05:00.000Z", "needs-review"),
        labels("2026-11-05T10:15:00.000Z", "backend needs-review"),
      ],
      expected: [],
    },
    {
      name: "a status the JQL names, left and returned to",
      jql: 'status = "To Do"',
      histories: [
        status("2026-11-05T10:05:00.000Z", "In Progress"),
        status("2026-11-05T10:10:00.000Z", "Review"),
        status("2026-11-05T10:15:00.000Z", "To Do"),
      ],
      expected: [{ leftAt: "2026-11-05T10:05:00.000Z", enteredAt: "2026-11-05T10:15:00.000Z" }],
    },
    {
      name: "history at or before the stored update",
      jql: "labels = needs-review",
      histories: [
        labels("2026-11-05T09:55:00.000Z", "backend"),
        labels(AT, "backend needs-review"),
      ],
      expected: [],
    },
    {
      name: "a stored state without an update time",
      jql: "labels = needs-review",
      previous: issue({ labels: ["backend", "needs-review"] }),
      histories: [
        labels("2026-11-05T10:05:00.000Z", "backend"),
        labels("2026-11-05T10:15:00.000Z", "backend needs-review"),
      ],
      expected: [],
    },
  ];

  it.each(cases)("$name", (testCase) => {
    assert.deepEqual(
      jiraQueryRoundTrips(testCase.previous ?? before, after, testCase.histories, testCase.jql),
      testCase.expected,
    );
  });
});
