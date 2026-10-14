import { describe, expect, it } from "@effect/vitest";

import { resolveFieldIds, toIssueSummary, toTransition } from "./issueMapping.ts";

const fieldIds = { sprint: "customfield_10020", storyPoints: "customfield_10016" };

describe("toIssueSummary", () => {
  it("maps a full issue, keying status off its category", () => {
    expect(
      toIssueSummary(
        {
          id: "10001",
          key: "ABC-12",
          fields: {
            summary: "Fix the login",
            status: { name: "Code Review", statusCategory: { key: "indeterminate" } },
            issuetype: { name: "Bug" },
            priority: { name: "High" },
            assignee: {
              accountId: "acc-1",
              displayName: "Ada",
              avatarUrls: { "48x48": "https://avatar/48", "24x24": "https://avatar/24" },
            },
            updated: "2026-10-01T12:34:56.789+0200",
            customfield_10020: [
              { id: 7, name: "Sprint 7", state: "closed", boardId: 1 },
              "com.atlassian.greenhopper.service.sprint.Sprint@1[id=8,name=Sprint 8,state=ACTIVE]",
              { id: 8, name: "Sprint 8", state: "active" },
              { id: "9", name: "Bad id", state: "future" },
            ],
            customfield_10016: 5,
          },
        },
        { site: "acme.atlassian.net", fieldIds },
      ),
    ).toEqual({
      site: "acme.atlassian.net",
      key: "ABC-12",
      url: "https://acme.atlassian.net/browse/ABC-12",
      summary: "Fix the login",
      status: "Code Review",
      statusCategory: "in-progress",
      issueType: "Bug",
      priority: "High",
      assignee: { accountId: "acc-1", displayName: "Ada", avatarUrl: "https://avatar/48" },
      sprints: [
        { id: 7, name: "Sprint 7", state: "closed" },
        { id: 8, name: "Sprint 8", state: "active" },
      ],
      storyPoints: 5,
      updated: "2026-10-01T10:34:56.789Z",
    });
  });

  it("maps status categories and tolerates missing optional fields", () => {
    const summary = (category: string | undefined, fields: Record<string, unknown> = {}) =>
      toIssueSummary(
        {
          id: "1",
          key: "ABC-1",
          fields: {
            summary: "S",
            status: { name: "X", statusCategory: { key: category } },
            assignee: null,
            priority: null,
            ...fields,
          },
        },
        { site: "acme.atlassian.net", fieldIds },
      );
    expect(summary("new").statusCategory).toBe("todo");
    expect(summary("indeterminate").statusCategory).toBe("in-progress");
    expect(summary("done").statusCategory).toBe("done");
    expect(summary(undefined).statusCategory).toBe("todo");

    const bare = summary("done");
    expect(bare.assignee).toBeNull();
    expect(bare.priority).toBeNull();
    expect(bare.issueType).toBeNull();
    expect(bare.sprints).toEqual([]);
    expect(bare.storyPoints).toBeNull();
    expect(bare.updated).toBeNull();
    expect(summary("done", { customfield_10016: "3" }).storyPoints).toBeNull();
  });

  it("prefers the untranslated status and issue type names over the profile language's", () => {
    const summary = toIssueSummary(
      {
        id: "1",
        key: "ABC-1",
        fields: {
          status: {
            name: "待办",
            untranslatedName: "To Do",
            statusCategory: { key: "new" },
          },
          issuetype: { name: "缺陷", untranslatedName: "Bug" },
        },
      },
      { site: "acme.atlassian.net", fieldIds },
    );
    expect([summary.status, summary.issueType]).toEqual(["To Do", "Bug"]);

    const untranslated = toIssueSummary(
      { id: "1", key: "ABC-1", fields: { status: { name: "待办" }, issuetype: { name: "任务" } } },
      { site: "acme.atlassian.net", fieldIds },
    );
    expect([untranslated.status, untranslated.issueType]).toEqual(["待办", "任务"]);

    expect(
      toTransition({ id: "11", name: "Start", to: { name: "进行中", untranslatedName: "Doing" } })
        .toStatus,
    ).toBe("Doing");
  });

  it("ignores sprint and story point values when the site has no such fields", () => {
    const summary = toIssueSummary(
      {
        id: "1",
        key: "ABC-1",
        fields: {
          customfield_10020: [{ id: 1, name: "S", state: "active" }],
          customfield_10016: 2,
        },
      },
      { site: "acme.atlassian.net", fieldIds: { sprint: null, storyPoints: null } },
    );
    expect(summary.sprints).toEqual([]);
    expect(summary.storyPoints).toBeNull();
  });
});

describe("resolveFieldIds", () => {
  const sprint = {
    id: "customfield_10020",
    name: "Sprint",
    schema: { type: "array", custom: "com.pyxis.greenhopper.jira:gh-sprint" },
  };
  const storyPoints = {
    id: "customfield_10028",
    name: "Story Points",
    schema: { type: "number", custom: "com.atlassian.jira.plugin.system.customfieldtypes:float" },
  };
  const estimate = {
    id: "customfield_10016",
    name: "Story point estimate",
    schema: { type: "number", custom: "com.atlassian.jira.plugin.system.customfieldtypes:float" },
  };
  const jswStoryPoints = {
    id: "customfield_10030",
    name: "Points",
    schema: { type: "number", custom: "com.pyxis.greenhopper.jira:jsw-story-points" },
  };

  it("prefers the story point estimate field over Story Points", () => {
    expect(
      resolveFieldIds([{ id: "summary", name: "Summary" }, storyPoints, sprint, estimate]),
    ).toEqual({
      sprint: "customfield_10020",
      storyPoints: "customfield_10016",
    });
    expect(resolveFieldIds([storyPoints, jswStoryPoints])).toEqual({
      sprint: null,
      storyPoints: "customfield_10030",
    });
    expect(resolveFieldIds([storyPoints])).toEqual({
      sprint: null,
      storyPoints: "customfield_10028",
    });
    expect(resolveFieldIds([])).toEqual({ sprint: null, storyPoints: null });
  });
});
