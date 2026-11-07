import { describe, expect, it } from "vite-plus/test";

import {
  emptyTriggerFilterDraft,
  parseTriggerFilterDrafts,
  splitEventTypeFilter,
  triggerEventTypes,
  triggerFilterDrafts,
  triggerFilterDraftsChanged,
  triggerFiltersSummary,
  withEventTypeDrafts,
} from "./scheduledTaskTrigger.ts";

const draft = (path: string, op: "equals" | "in" | "exists", value = "") => ({
  id: path,
  path,
  op,
  value,
});

describe("trigger filter drafts", () => {
  it("starts a new row on the source's first field", () => {
    expect(emptyTriggerFilterDraft("jira")).toMatchObject({ path: "event.type", op: "equals" });
  });

  it("parses rows the source exposes and round-trips them", () => {
    const parsed = parseTriggerFilterDrafts(
      [
        draft("event.status", "equals", "In Progress"),
        draft(" event.labels ", "in", "agent, urgent,"),
        draft("event.assignee", "exists", "ignored"),
      ],
      "jira",
    );
    expect(parsed).toEqual({
      filters: [
        { path: "event.status", op: "equals", value: "In Progress" },
        { path: "event.labels", op: "in", value: ["agent", "urgent"] },
        { path: "event.assignee", op: "exists" },
      ],
    });
    if (!("filters" in parsed)) return;
    const drafts = triggerFilterDrafts(parsed.filters);
    expect(drafts.map(({ path, op, value }) => ({ path, op, value }))).toEqual([
      { path: "event.status", op: "equals", value: "In Progress" },
      { path: "event.labels", op: "in", value: "agent, urgent" },
      { path: "event.assignee", op: "exists", value: "" },
    ]);
    expect(triggerFilterDraftsChanged(drafts, drafts)).toBe(false);
  });

  it("rejects fields the source lacks and lists without values", () => {
    expect(parseTriggerFilterDrafts([draft("event.status", "exists")], "gitlab")).toEqual({
      error: "Filter 1 needs a field this source has.",
    });
    expect(parseTriggerFilterDrafts([draft("body.action", "exists")], "slack")).toEqual({
      error: "Filter 1 needs a field this source has.",
    });
    expect(parseTriggerFilterDrafts([draft("event.labels", "in", " , ")], "jira")).toEqual({
      error: "Filter 1 needs at least one value.",
    });
  });
});

describe("event type picker", () => {
  it("reads a stored type filter into the picker and leaves the other filters", () => {
    expect(
      splitEventTypeFilter("jira_query", [
        { path: "event.status", op: "equals", value: "Done" },
        { path: "event.type", op: "in", value: ["issue.entered", "issue.left"] },
      ]),
    ).toEqual({
      eventTypes: ["issue.entered", "issue.left"],
      filters: [{ path: "event.status", op: "equals", value: "Done" }],
    });
  });

  it("offers every type when no filter picks some, and keeps filters it cannot show", () => {
    const unknown = { path: "event.type", op: "in", value: ["issue.created"] } as const;
    const equals = { path: "event.type", op: "equals", value: "issue.left" } as const;
    expect(splitEventTypeFilter("gitlab", [])).toEqual({
      eventTypes: triggerEventTypes("gitlab"),
      filters: [],
    });
    expect(splitEventTypeFilter("jira_query", [unknown, equals])).toEqual({
      eventTypes: triggerEventTypes("jira_query"),
      filters: [unknown, equals],
    });
    expect(triggerEventTypes("slack")).toBeNull();
  });

  it("saves a partial choice as a type filter first, and every type as none", () => {
    const rows = [draft("event.status", "equals", "Done")];
    expect(
      withEventTypeDrafts("gitlab_projects", ["merge_request.opened"], rows).map(
        ({ path, op, value }) => ({ path, op, value }),
      ),
    ).toEqual([
      { path: "event.type", op: "in", value: "merge_request.opened" },
      { path: "event.status", op: "equals", value: "Done" },
    ]);
    expect(withEventTypeDrafts("jira", triggerEventTypes("jira") ?? [], rows)).toEqual(rows);
  });

  it("summarizes the chosen types apart from the other filters", () => {
    expect(
      triggerFiltersSummary("jira_query", [
        { path: "event.status", op: "equals", value: "Done" },
        { path: "event.type", op: "in", value: ["issue.entered", "issue.left"] },
      ]),
    ).toBe("Act on issue.entered, issue.left · Status equals Done");
  });
});
