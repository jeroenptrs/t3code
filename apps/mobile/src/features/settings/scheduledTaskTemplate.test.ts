import { describe, expect, it } from "vite-plus/test";
import { ProjectId, type TriggerTemplate } from "@t3tools/contracts";

import { scheduleFromDraft } from "./scheduledTaskDraft";
import { scheduledTaskDraftFromTemplate } from "./scheduledTaskTemplate";

const context = { projectId: ProjectId.make("project-1"), modelSelection: null };

const jiraTemplate: TriggerTemplate = {
  name: "issue-in-progress",
  title: "Issue enters In Progress",
  source: "jira",
  filters: [
    { path: "event.type", op: "equals", value: "issue.status_changed" },
    { path: "event.status", op: "equals", value: "{{status}}" },
    { path: "event.labels", op: "in", value: ["{{label}}", "urgent"] },
  ],
  prompt: "Work on {{event.key}} in {{status}}.",
  placeholders: [
    { name: "status", default: "In Progress" },
    { name: "label", description: "Label that marks agent work" },
  ],
};

describe("scheduledTaskDraftFromTemplate", () => {
  it("fills an event template's filters and prompt into a new task draft", () => {
    const result = scheduledTaskDraftFromTemplate(jiraTemplate, { label: "agent" }, context);
    if (!("draft" in result)) throw new Error(result.error);
    expect(result.draft).toMatchObject({
      task: null,
      title: "Issue enters In Progress",
      prompt: "Work on {{event.key}} in In Progress.",
      projectId: context.projectId,
    });
    expect(scheduleFromDraft(result.draft.schedule)).toEqual({
      type: "jira",
      filters: [
        { path: "event.type", op: "equals", value: "issue.status_changed" },
        { path: "event.status", op: "equals", value: "In Progress" },
        { path: "event.labels", op: "in", value: ["agent", "urgent"] },
      ],
    });
  });

  it("keeps webhook filters on webhook templates", () => {
    const result = scheduledTaskDraftFromTemplate(
      {
        name: "deploy-failed",
        title: "Deploy failed",
        source: "webhook",
        filters: [{ path: "body.service", op: "equals", value: "{{service}}" }],
        prompt: "Investigate the failed deploy of {{service}}.",
        placeholders: [{ name: "service" }],
      },
      { service: "api" },
      context,
    );
    if (!("draft" in result)) throw new Error(result.error);
    expect(result.draft.prompt).toBe("Investigate the failed deploy of api.");
    expect(scheduleFromDraft(result.draft.schedule)).toMatchObject({
      type: "webhook",
      filters: [{ path: "body.service", op: "equals", value: "api" }],
    });
  });

  it("names a required placeholder left blank", () => {
    expect(scheduledTaskDraftFromTemplate(jiraTemplate, { label: "  " }, context)).toEqual({
      error: "Fill in label.",
    });
  });
});
