import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ScheduledTask } from "./scheduledTask.ts";
import {
  fillTriggerTemplate,
  scheduledTaskTrigger,
  triggerUpsertToScheduledTaskUpsert,
  TriggerSaveInput,
  TriggerTemplate,
} from "./trigger.ts";

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
  it("maps a stored interval task to a schedule source and back unchanged", () => {
    const interval = { type: "interval", everyMs: 60_000 };
    const stored = task(interval);
    const trigger = scheduledTaskTrigger(stored);
    expect(trigger).toEqual({
      id: "task-1",
      title: "Task",
      prompt: "Do it",
      enabled: true,
      source: { kind: "schedule", schedule: interval },
      filters: [],
      target: {
        type: "thread",
        projectId: "project-1",
        threadId: null,
        threadMode: "new_thread",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "auto",
        interactionMode: "default",
      },
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
    expect(triggerUpsertToScheduledTaskUpsert(trigger)).toEqual({
      id: "task-1",
      title: "Task",
      prompt: "Do it",
      enabled: true,
      schedule: interval,
      projectId: "project-1",
      threadId: null,
      threadMode: "new_thread",
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "auto",
      interactionMode: "default",
    });
  });

  it("keeps a webhook source's signature and dedupe, and its filters", () => {
    const signature = { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" };
    const dedupe = { replayKey: "{{headers.x-delivery}}", coalesceWindowSeconds: 60 };
    const webhookFilter = { path: "body.action", op: "equals", value: "opened" };
    const webhook = scheduledTaskTrigger(
      task(
        {
          type: "webhook",
          signature,
          maxDeliveryAgeMinutes: 30,
          dedupe,
          filters: [webhookFilter],
        },
        "thread-1",
      ),
    );
    expect(webhook.source).toEqual({
      kind: "webhook",
      signature,
      maxDeliveryAgeMinutes: 30,
      dedupe,
    });
    expect(webhook.filters).toEqual([webhookFilter]);
    expect(webhook.target).toMatchObject({ threadId: "thread-1", threadMode: "continue" });
  });

  it("maps a Jira query source with its query and interval, its filters apart", () => {
    const filter = { path: "event.changedFields", op: "equals", value: "priority" };
    const trigger = scheduledTaskTrigger(
      task({
        type: "jira_query",
        site: "acme.atlassian.net",
        filterId: "10042",
        everyMs: 900_000,
        filters: [filter],
      }),
    );
    expect(trigger.source).toEqual({
      kind: "jira_query",
      site: "acme.atlassian.net",
      filterId: "10042",
      everyMs: 900_000,
    });
    expect(trigger.filters).toEqual([filter]);
  });

  it("keeps a Jira source's filters", () => {
    const jiraFilter = { path: "event.status", op: "in", value: ["In Progress"] };
    const jira = scheduledTaskTrigger(task({ type: "jira", filters: [jiraFilter] }));
    expect(jira.source).toEqual({ kind: "jira" });
    expect(jira.filters).toEqual([jiraFilter]);
    expect(scheduledTaskTrigger(task({ type: "gitlab" })).filters).toEqual([]);
    expect(scheduledTaskTrigger(task({ type: "manual" })).source).toEqual({ kind: "manual" });
  });

  it("round-trips every schedule kind through a save", () => {
    const schedules = [
      { type: "interval", everyMs: 900_000 },
      { type: "fixed_time", timeOfDay: "09:30", timeZone: "Europe/Amsterdam", weekdays: [1, 5] },
      { type: "once", runAt: "2026-11-09T09:00:00.000Z" },
      {
        type: "webhook",
        signature: { header: "x-sig", encoding: "base64", prefix: "" },
        maxDeliveryAgeMinutes: null,
        dedupe: { coalesceKey: "{{body.id}}" },
        filters: [{ path: "headers.x-event", op: "exists" }],
      },
      { type: "jira", filters: [{ path: "event.status", op: "equals", value: "In Progress" }] },
      { type: "gitlab", filters: [{ path: "event.type", op: "equals", value: "pipeline.failed" }] },
      { type: "slack", filters: [{ path: "event.prompt", op: "startsWith", value: "deploy" }] },
      { type: "manual" },
      {
        type: "jira_query",
        site: "acme.atlassian.net",
        jql: "project = PROJ AND labels = agent",
        everyMs: 900_000,
        filters: [{ path: "event.type", op: "equals", value: "issue.entered" }],
      },
      {
        type: "jira_query",
        site: "acme.atlassian.net",
        filterId: "10042",
        everyMs: 300_000,
        filters: [],
      },
    ];
    for (const schedule of schedules) {
      const stored = task(schedule, "thread-1");
      expect(triggerUpsertToScheduledTaskUpsert(scheduledTaskTrigger(stored)).schedule).toEqual(
        stored.schedule,
      );
    }
  });
});

describe("TriggerSaveInput", () => {
  const decodeSave = Schema.decodeUnknownSync(TriggerSaveInput);
  const save = (source: unknown, filters: unknown[]) => ({
    title: "Pick up work",
    prompt: "Work on {{event.key}}",
    enabled: true,
    source,
    filters,
    target: {
      type: "thread",
      projectId: "project-1",
      threadId: null,
      threadMode: "new_thread",
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "auto",
      interactionMode: "default",
    },
  });
  const statusFilter = { path: "event.status", op: "equals", value: "In Progress" };

  it("rejects filters the source cannot match", () => {
    expect(decodeSave(save({ kind: "jira" }, [statusFilter])).filters).toEqual([statusFilter]);
    expect(() => decodeSave(save({ kind: "webhook" }, [statusFilter]))).toThrow();
    expect(() =>
      decodeSave(save({ kind: "jira" }, [{ path: "body.action", op: "exists" }])),
    ).toThrow();
    expect(() =>
      decodeSave(
        save({ kind: "schedule", schedule: { type: "interval", everyMs: 60_000 } }, [statusFilter]),
      ),
    ).toThrow();
    const query = { kind: "jira_query", site: "acme.atlassian.net", everyMs: 900_000 };
    expect(decodeSave(save({ ...query, jql: "project = PROJ" }, [statusFilter])).source).toEqual({
      ...query,
      jql: "project = PROJ",
    });
    expect(() => decodeSave(save(query, []))).toThrow();
    expect(() =>
      decodeSave(save({ ...query, jql: "project = PROJ", filterId: "1" }, [])),
    ).toThrow();
    expect(() =>
      decodeSave(save({ ...query, jql: "project = PROJ", everyMs: 60_000 }, [])),
    ).toThrow();
    expect(() =>
      decodeSave(
        save({ ...query, jql: "project = PROJ" }, [{ path: "body.action", op: "exists" }]),
      ),
    ).toThrow();
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
