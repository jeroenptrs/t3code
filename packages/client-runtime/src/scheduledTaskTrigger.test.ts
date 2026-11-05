import { describe, expect, it } from "vite-plus/test";

import {
  emptyTriggerFilterDraft,
  parseTriggerFilterDrafts,
  triggerFilterDrafts,
  triggerFilterDraftsChanged,
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
