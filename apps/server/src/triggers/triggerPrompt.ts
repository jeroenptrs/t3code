// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous hash for a stable id.
import * as NodeCrypto from "node:crypto";

import { TRIGGER_SOURCE_FIELDS, type TriggerEvent } from "@t3tools/contracts";

import { type RenderedWebhookPrompt, renderTemplate } from "../scheduledTasks/webhookTemplate.ts";
import { gitlabPipelineKey, gitlabTriggerKey } from "./gitlabTriggerSource.ts";
import { jiraTriggerKey } from "./jiraTriggerSource.ts";
import { triggerFieldResolver } from "./triggerFilter.ts";

/** The thing an event is about, keyed as its source observes it. */
function triggerEventKey(event: TriggerEvent): string {
  switch (event.source) {
    case "jira":
    case "jira_query":
      return jiraTriggerKey(event.payload.site, event.payload.key);
    case "gitlab":
      return gitlabTriggerKey({
        host: event.payload.host,
        repository: event.payload.repository,
        number: Number(event.payload.number),
      });
    case "gitlab_projects":
      return event.payload.pipelineId === null || event.type !== "pipeline.finished"
        ? gitlabTriggerKey({
            host: event.payload.host,
            repository: event.payload.repository,
            number: Number(event.payload.number),
          })
        : gitlabPipelineKey(event.payload.host, event.payload.repository, event.payload.pipelineId);
    case "slack":
      return event.payload.invocationId;
    case "manual":
      return "";
  }
}

/** Stable per event, so raising the same event twice runs a task once. */
export function triggerEventId(event: TriggerEvent): string {
  const forTrigger = event.triggerId === undefined ? "" : `|${event.triggerId}`;
  return NodeCrypto.createHash("sha256")
    .update(
      `${event.source}|${triggerEventKey(event)}|${event.type}|${event.occurredAt}${forTrigger}`,
    )
    .digest("hex");
}

/** `{{event}}` is the payload as JSON, `{{event.<field>}}` one field; lists join with commas. */
export function renderTriggerPrompt(
  template: string,
  event: TriggerEvent,
  frameId: string,
): RenderedWebhookPrompt {
  const field = triggerFieldResolver(event);
  return renderTemplate(
    template,
    (expression) => {
      if (expression === "event") return event.payload;
      const value = field(expression);
      return Array.isArray(value) ? value.join(", ") : value;
    },
    frameId,
    "trigger",
  );
}

/**
 * The event's non-empty fields one per line as `label: value` for a work item, each value framed
 * as untrusted data like a thread run's prompt. Empty for a manual run.
 */
export function renderTriggerEventText(event: TriggerEvent, frameId: string): string {
  if (event.source === "manual") return "";
  const field = triggerFieldResolver(event);
  const lines = TRIGGER_SOURCE_FIELDS[event.source].flatMap(({ path, label }) => {
    const value = field(path);
    const text = Array.isArray(value) ? value.join(", ") : value;
    return typeof text === "string" && text !== "" ? [`${label}: {{${path}}}`] : [];
  });
  return renderTriggerPrompt(lines.join("\n"), event, frameId).prompt;
}

/** `<type> <key or number>: <summary or title>` for Jira and GitLab events; null for others. */
export function triggerEventTitle(event: TriggerEvent): string | null {
  switch (event.source) {
    case "jira":
    case "jira_query":
      return `${event.type} ${event.payload.key}: ${event.payload.summary}`;
    case "gitlab":
    case "gitlab_projects":
      return `${event.type} ${event.payload.number}: ${event.payload.title}`;
    case "slack":
    case "manual":
      return null;
  }
}
