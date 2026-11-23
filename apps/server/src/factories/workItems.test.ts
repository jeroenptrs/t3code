import { describe, expect, it } from "vite-plus/test";
import { FactoryName, ScheduledTaskId, WorkItemId } from "@t3tools/contracts";

import { renderWorkItemMessage } from "./workItems.ts";

describe("renderWorkItemMessage", () => {
  it("names the trigger and its source, then the event's fields", () => {
    const message = renderWorkItemMessage({
      workItemId: WorkItemId.make("work-item:1"),
      factoryName: FactoryName.make("triage"),
      title: "Nightly sweep",
      source: {
        kind: "trigger",
        triggerId: ScheduledTaskId.make("task:mrs"),
        title: "Nightly sweep",
        event: {
          source: "manual",
          type: "manual",
          occurredAt: "2026-11-07T09:00:00.000Z",
          payload: { type: "manual" },
        },
        text: "Look over the open merge requests.\n",
      },
      repositories: [
        { name: "api", path: "/work/shop/api" },
        { name: "web", path: "/work/shop/web" },
      ],
    });
    expect(message)
      .toBe(`Work item work-item:1 for the triage factory, from trigger Nightly sweep (manual).

Title: Nightly sweep

Look over the open merge requests.

Repositories the project covers. Name the one a child works in by name; the server picks its checkout:
- api
- web

Delegate each task with t3_factory_delegate, naming the role. Hold the item for a person with t3_work_item_gate, and end it with t3_work_item_advance.`);
  });
});
