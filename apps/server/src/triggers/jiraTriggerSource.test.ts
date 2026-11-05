import { assert, describe, it } from "@effect/vitest";
import type { JiraIssueSummary } from "@t3tools/contracts";

import { diffJiraIssue } from "./jiraTriggerSource.ts";

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
