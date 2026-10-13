import type { JiraIssueSummary, JiraSearchResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_JIRA_FACET_SELECTION,
  JIRA_FACET_NONE,
  collectJiraIssueFacets,
  groupJiraIssuesByStatusCategory,
  jiraIssueThreadPrompt,
  matchesJiraIssueFacets,
  mergeJiraSearchPages,
  proposeJiraIssueBranchName,
  readJiraIssuesViewId,
  sortJiraFilterViews,
  writeJiraIssuesViewId,
} from "./jiraIssueList.logic";

function issue(key: string, patch: Partial<JiraIssueSummary> = {}): JiraIssueSummary {
  return {
    site: "acme.atlassian.net",
    key,
    url: `https://acme.atlassian.net/browse/${key}`,
    summary: `Summary of ${key}`,
    status: "To Do",
    statusCategory: "todo",
    issueType: "Task",
    priority: "Medium",
    assignee: null,
    sprints: [],
    storyPoints: null,
    updated: null,
    ...patch,
  };
}

const ada = { accountId: "acc-ada", displayName: "Ada", avatarUrl: "https://a/ada.png" };
const bob = { accountId: "acc-bob", displayName: "Bob", avatarUrl: null };

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("groupJiraIssuesByStatusCategory", () => {
  it("orders groups by category, never by status name, and keeps the search order inside", () => {
    const groups = groupJiraIssuesByStatusCategory([
      issue("A-1", { status: "Shipped", statusCategory: "done" }),
      issue("A-2", { status: "Review", statusCategory: "in-progress" }),
      issue("A-3", { status: "Backlog", statusCategory: "todo" }),
      issue("A-4", { status: "Coding", statusCategory: "in-progress" }),
    ]);
    expect(groups.map((group) => group.category)).toEqual(["todo", "in-progress", "done"]);
    expect(groups.map((group) => group.issues.map((entry) => entry.key))).toEqual([
      ["A-3"],
      ["A-2", "A-4"],
      ["A-1"],
    ]);
  });
});

describe("mergeJiraSearchPages", () => {
  it("appends pages, drops a row that moved onto a later page, and continues from the last token", () => {
    const pages: JiraSearchResult[] = [
      { issues: [issue("A-1"), issue("A-2")], nextPageToken: "t1", filter: null },
      { issues: [issue("A-2"), issue("A-3")], nextPageToken: null, filter: null },
    ];
    const merged = mergeJiraSearchPages(pages);
    expect(merged.issues.map((entry) => entry.key)).toEqual(["A-1", "A-2", "A-3"]);
    expect(merged.nextPageToken).toBeNull();
    expect(mergeJiraSearchPages(pages.slice(0, 1)).nextPageToken).toBe("t1");
  });
});

describe("sortJiraFilterViews", () => {
  it("puts starred filters first, then sorts by name", () => {
    const view = (id: string, name: string, favourite: boolean) => ({
      site: "acme.atlassian.net",
      id,
      name,
      jql: "project = A",
      owner: null,
      favourite,
      url: `https://acme.atlassian.net/issues/?filter=${id}`,
    });
    const sorted = sortJiraFilterViews([
      view("1", "zeta", false),
      view("2", "Beta", true),
      view("3", "alpha", false),
      view("4", "Alpha starred", true),
    ]);
    expect(sorted.map((filter) => filter.id)).toEqual(["4", "2", "3", "1"]);
  });
});

describe("facets", () => {
  const issues = [
    issue("A-1", { assignee: ada, priority: "High", issueType: "Bug" }),
    issue("A-2", { assignee: ada, priority: "Medium", issueType: "Task" }),
    issue("A-3", { assignee: bob, priority: null, issueType: "Task" }),
    issue("A-4", { assignee: null, priority: "High", issueType: null }),
  ];

  it("counts each value over the loaded rows, most common first and none last", () => {
    const facets = collectJiraIssueFacets(issues);
    expect(facets.assignee.map((option) => [option.label, option.count])).toEqual([
      ["Ada", 2],
      ["Bob", 1],
      ["Unassigned", 1],
    ]);
    expect(facets.assignee[0]?.avatarUrl).toBe("https://a/ada.png");
    expect(facets.priority.map((option) => [option.value, option.count])).toEqual([
      ["High", 2],
      ["Medium", 1],
      [JIRA_FACET_NONE, 1],
    ]);
    expect(facets.issueType.map((option) => option.label)).toEqual(["Task", "Bug", "No type"]);
  });

  it("keeps a selected value that left the rows, so it can be cleared", () => {
    const facets = collectJiraIssueFacets(issues.slice(0, 1), {
      ...EMPTY_JIRA_FACET_SELECTION,
      priority: ["Low"],
    });
    expect(facets.priority.map((option) => [option.value, option.count])).toEqual([
      ["High", 1],
      ["Low", 0],
    ]);
  });

  it("ors values within a facet and ands facets together", () => {
    const keys = (selection: typeof EMPTY_JIRA_FACET_SELECTION) =>
      issues.filter((entry) => matchesJiraIssueFacets(entry, selection)).map((entry) => entry.key);
    expect(keys(EMPTY_JIRA_FACET_SELECTION)).toEqual(["A-1", "A-2", "A-3", "A-4"]);
    expect(keys({ ...EMPTY_JIRA_FACET_SELECTION, assignee: ["acc-bob", JIRA_FACET_NONE] })).toEqual(
      ["A-3", "A-4"],
    );
    expect(
      keys({ ...EMPTY_JIRA_FACET_SELECTION, assignee: ["acc-ada"], priority: ["High"] }),
    ).toEqual(["A-1"]);
    expect(keys({ ...EMPTY_JIRA_FACET_SELECTION, issueType: [JIRA_FACET_NONE] })).toEqual(["A-4"]);
  });
});

describe("proposeJiraIssueBranchName", () => {
  const target = { key: "ABC-123", summary: "Fix the login: redirect loop!" };

  it("carries the key under the project's static prefix", () => {
    expect(
      proposeJiraIssueBranchName(target, { mode: "static", prefix: "t3", instructions: "" }),
    ).toBe("t3/abc-123-fix-the-login-redirect-loop");
  });

  it("uses the bare sanitized name for semantic and custom naming", () => {
    expect(
      proposeJiraIssueBranchName(target, { mode: "semantic", prefix: "t3", instructions: "" }),
    ).toBe("abc-123-fix-the-login-redirect-loop");
    expect(
      proposeJiraIssueBranchName(target, {
        mode: "custom",
        prefix: "",
        instructions: "Use feature/<ticket>",
      }),
    ).toBe("abc-123-fix-the-login-redirect-loop");
  });
});

describe("jiraIssueThreadPrompt", () => {
  it("writes the key and summary, the description, the link and the branch, a blank line apart", () => {
    expect(
      jiraIssueThreadPrompt(
        {
          key: "ABC-123",
          summary: "Fix login",
          url: "https://acme.atlassian.net/browse/ABC-123",
          description: "Steps:\n\n1. Sign in\n",
        },
        "abc-123-fix-login",
      ),
    ).toBe(
      [
        "ABC-123: Fix login",
        "",
        "Steps:",
        "",
        "1. Sign in",
        "",
        "https://acme.atlassian.net/browse/ABC-123",
        "",
        "Branch: `abc-123-fix-login`",
      ].join("\n"),
    );
  });

  it("leaves out an empty description and a missing branch", () => {
    expect(
      jiraIssueThreadPrompt(
        { key: "A-1", summary: "S", url: "https://x/browse/A-1", description: "  " },
        null,
      ),
    ).toBe("A-1: S\n\nhttps://x/browse/A-1");
  });
});

describe("remembered view", () => {
  it("keeps one filter per environment", () => {
    const storage = memoryStorage();
    expect(readJiraIssuesViewId("env-a", storage)).toBeNull();
    writeJiraIssuesViewId("env-a", "10001", storage);
    writeJiraIssuesViewId("env-b", "10002", storage);
    writeJiraIssuesViewId("env-a", "10003", storage);
    expect(readJiraIssuesViewId("env-a", storage)).toBe("10003");
    expect(readJiraIssuesViewId("env-b", storage)).toBe("10002");
  });

  it("ignores storage it did not write", () => {
    const storage = memoryStorage();
    storage.setItem("t3.jiraIssues.views", "not json");
    expect(readJiraIssuesViewId("env-a", storage)).toBeNull();
    storage.setItem("t3.jiraIssues.views", JSON.stringify({ "env-a": 42 }));
    expect(readJiraIssuesViewId("env-a", storage)).toBeNull();
  });
});
