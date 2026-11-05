import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ScheduledTask } from "./scheduledTask.ts";
import { fillTriggerTemplate, scheduledTaskTrigger, TriggerTemplate } from "./trigger.ts";

const decodeTask = Schema.decodeUnknownSync(ScheduledTask);
const decodeTemplate = Schema.decodeSync(TriggerTemplate);

const task = (schedule: unknown, threadId: string | null = null) =>
  decodeTask({
    id: "task-1",
    title: "Task",
    prompt: "Do it",
    enabled: true,
    schedule,
    projectId: "project-1",
    threadId,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "auto",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  });

describe("scheduledTaskTrigger", () => {
  it("maps each schedule to its source and keeps filters and the thread target", () => {
    const interval = { type: "interval", everyMs: 60_000 };
    expect(scheduledTaskTrigger(task(interval))).toEqual({
      source: { kind: "schedule", schedule: interval },
      filters: [],
      target: {
        type: "thread",
        projectId: "project-1",
        threadId: null,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "auto",
        interactionMode: "default",
      },
    });

    const webhookFilter = { path: "body.action", op: "equals", value: "opened" };
    const webhook = scheduledTaskTrigger(
      task({ type: "webhook", signature: null, filters: [webhookFilter] }, "thread-1"),
    );
    expect(webhook.source).toEqual({ kind: "webhook" });
    expect(webhook.filters).toEqual([webhookFilter]);
    expect(webhook.target.threadId).toBe("thread-1");

    const jiraFilter = { path: "event.status", op: "in", value: ["In Progress"] };
    const jira = scheduledTaskTrigger(task({ type: "jira", filters: [jiraFilter] }));
    expect(jira.source).toEqual({ kind: "jira" });
    expect(jira.filters).toEqual([jiraFilter]);

    expect(scheduledTaskTrigger(task({ type: "gitlab" })).filters).toEqual([]);
    expect(scheduledTaskTrigger(task({ type: "manual" })).source).toEqual({ kind: "manual" });
  });
});

describe("fillTriggerTemplate", () => {
  const template = decodeTemplate({
    name: "issue-in-progress",
    title: "Issue enters a status",
    source: "jira",
    filters: [
      { path: "event.type", op: "equals", value: "issue.status_changed" },
      { path: "event.status", op: "equals", value: "{{status}}" },
      { path: "event.labels", op: "in", value: ["{{label}}", "urgent"] },
      { path: "event.assignee", op: "exists" },
    ],
    prompt: "Move {{event.key}} out of {{ status }} for {{owner}}. Payload: {{event}}",
    placeholders: [
      { name: "status", default: "In Progress" },
      { name: "label", description: "Label that marks the work" },
      { name: "owner" },
    ],
  });

  it("fills values, falls back to defaults, and leaves event placeholders alone", () => {
    expect(fillTriggerTemplate(template, { label: "agent", owner: "Ana", status: " " })).toEqual({
      filters: [
        { path: "event.type", op: "equals", value: "issue.status_changed" },
        { path: "event.status", op: "equals", value: "In Progress" },
        { path: "event.labels", op: "in", value: ["agent", "urgent"] },
        { path: "event.assignee", op: "exists" },
      ],
      prompt: "Move {{event.key}} out of In Progress for Ana. Payload: {{event}}",
      missing: [],
    });
  });

  it("reports placeholders without a value or default and leaves them unfilled", () => {
    const filled = fillTriggerTemplate(template, { status: "Review" });
    expect(filled.missing).toEqual(["label", "owner"]);
    expect(filled.filters[2]).toEqual({
      path: "event.labels",
      op: "in",
      value: ["{{label}}", "urgent"],
    });
    expect(filled.prompt).toBe(
      "Move {{event.key}} out of Review for {{owner}}. Payload: {{event}}",
    );
  });

  it("rejects placeholder names that run time fills", () => {
    expect(() => decodeTemplate({ ...template, placeholders: [{ name: "event" }] })).toThrow();
  });
});
