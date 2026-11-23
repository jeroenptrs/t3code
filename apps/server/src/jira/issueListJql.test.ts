import { describe, expect, it } from "@effect/vitest";

import { buildIssueListJql, jqlString } from "./issueListJql.ts";

const base = { scope: "ABC", state: "all", involvement: "all", sort: "updated" } as const;

describe("buildIssueListJql", () => {
  it.each([
    [base, 'project = "ABC" ORDER BY updated DESC'],
    [
      { ...base, state: "open", sort: "created" },
      'project = "ABC" AND statusCategory != Done ORDER BY created DESC',
    ],
    [
      { ...base, state: "closed" },
      'project = "ABC" AND statusCategory = Done ORDER BY updated DESC',
    ],
    [
      { ...base, involvement: "assigned" },
      'project = "ABC" AND assignee = currentUser() ORDER BY updated DESC',
    ],
    [
      { ...base, involvement: "authored" },
      'project = "ABC" AND reporter = currentUser() ORDER BY updated DESC',
    ],
    [
      { ...base, involvement: "mentioned" },
      'project = "ABC" AND watcher = currentUser() ORDER BY updated DESC',
    ],
    [
      { ...base, assignee: "Ada Lovelace", labels: ["backend", "agent"], query: "login fails" },
      'project = "ABC" AND assignee = "Ada Lovelace" AND labels = "backend" AND labels = "agent" AND text ~ "login fails" ORDER BY updated DESC',
    ],
  ] as const)("builds %o", (input, jql) => {
    expect(buildIssueListJql(input)).toBe(jql);
  });

  it("keeps hostile values inside their string literal", () => {
    const hostile = '" OR project != "ABC" ORDER BY key ASC --';
    const jql = buildIssueListJql({
      ...base,
      scope: 'ABC" OR project = "SECRET',
      assignee: hostile,
      labels: ['x") OR (labels = "y', "tail\\"],
      query: hostile,
    });
    expect(jql).toBe(
      'project = "ABC\\" OR project = \\"SECRET"' +
        ' AND assignee = "\\" OR project != \\"ABC\\" ORDER BY key ASC --"' +
        ' AND labels = "x\\") OR (labels = \\"y" AND labels = "tail\\\\"' +
        ' AND text ~ "OR project = ABC ORDER BY key ASC"' +
        " ORDER BY updated DESC",
    );
    // Every quote a value brought is escaped, so the literals still pair up as written.
    expect(jql.replaceAll("\\\\", "").replaceAll('\\"', "").match(/"/g)).toHaveLength(10);
  });

  it("flattens line breaks and leaves out a query that is only search syntax", () => {
    expect(jqlString("a\nb c\u0000d")).toBe('"a b c d"');
    expect(buildIssueListJql({ ...base, query: '"*~ (?) :' })).toBe(
      'project = "ABC" ORDER BY updated DESC',
    );
  });
});
