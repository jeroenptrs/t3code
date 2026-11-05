import { assert, describe, it } from "@effect/vitest";
import type { TriggerEvent, TriggerFilter } from "@t3tools/contracts";

import { findFailedTriggerFilter } from "./triggerFilter.ts";

const event: TriggerEvent = {
  source: "jira",
  type: "issue.labels_changed",
  occurredAt: "2026-11-05T10:00:00.000Z",
  payload: {
    type: "issue.labels_changed",
    site: "acme.atlassian.net",
    key: "PROJ-7",
    projectKey: "PROJ",
    url: "https://acme.atlassian.net/browse/PROJ-7",
    summary: "Fix login",
    status: "In Progress",
    statusCategory: "in-progress",
    previousStatus: "To Do",
    previousStatusCategory: "todo",
    issueType: "Bug",
    priority: null,
    assignee: null,
    assigneeAccountId: null,
    previousAssigneeAccountId: null,
    labels: ["agent", "backend"],
    addedLabels: ["agent"],
    removedLabels: [],
  },
};

const failed = (filters: ReadonlyArray<TriggerFilter>) => findFailedTriggerFilter(filters, event);

describe("findFailedTriggerFilter", () => {
  it("matches every event when there are no filters", () => {
    assert.isNull(failed([]));
  });

  it("compares scalar fields", () => {
    assert.isNull(
      failed([
        { path: "event.type", op: "equals", value: "issue.labels_changed" },
        { path: "event.status", op: "notEquals", value: "Done" },
        { path: "event.key", op: "startsWith", value: "PROJ-" },
        { path: "event.issueType", op: "in", value: ["Bug", "Story"] },
        { path: "event.summary", op: "exists" },
      ]),
    );
    assert.deepEqual(failed([{ path: "event.status", op: "equals", value: "Done" }]), {
      index: 0,
      path: "event.status",
    });
  });

  it("matches array fields when any element matches, without a [] in the path", () => {
    assert.isNull(
      failed([
        { path: "event.labels", op: "equals", value: "backend" },
        { path: "event.labels", op: "in", value: ["frontend", "agent"] },
        { path: "event.labels", op: "startsWith", value: "back" },
        { path: "event.addedLabels", op: "exists" },
      ]),
    );
    assert.deepEqual(failed([{ path: "event.labels", op: "equals", value: "frontend" }]), {
      index: 0,
      path: "event.labels",
    });
  });

  it("passes notEquals on an array only when no element equals", () => {
    assert.isNull(failed([{ path: "event.labels", op: "notEquals", value: "frontend" }]));
    assert.deepEqual(failed([{ path: "event.labels", op: "notEquals", value: "agent" }]), {
      index: 0,
      path: "event.labels",
    });
  });

  it("fails exists on an empty array", () => {
    assert.deepEqual(failed([{ path: "event.removedLabels", op: "exists" }]), {
      index: 0,
      path: "event.removedLabels",
    });
  });

  it("fails every op on a null field, exists included", () => {
    for (const filter of [
      { path: "event.priority", op: "exists" },
      { path: "event.priority", op: "notEquals", value: "High" },
      { path: "event.priority", op: "equals", value: "" },
      { path: "event.priority", op: "in", value: ["High"] },
      { path: "event.priority", op: "startsWith", value: "" },
    ] satisfies ReadonlyArray<TriggerFilter>) {
      assert.deepEqual(failed([filter]), { index: 0, path: "event.priority" });
    }
  });

  it("fails a field the event does not have", () => {
    assert.deepEqual(failed([{ path: "event.repository", op: "exists" }]), {
      index: 0,
      path: "event.repository",
    });
    assert.deepEqual(failed([{ path: "event.toString", op: "exists" }]), {
      index: 0,
      path: "event.toString",
    });
  });

  it("reports the first failing filter", () => {
    assert.deepEqual(
      failed([
        { path: "event.type", op: "equals", value: "issue.labels_changed" },
        { path: "event.labels", op: "equals", value: "frontend" },
        { path: "event.status", op: "equals", value: "Done" },
      ]),
      { index: 1, path: "event.labels" },
    );
  });
});
