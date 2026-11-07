// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous hash for a stable id.
import * as NodeCrypto from "node:crypto";

import type { TriggerEvent } from "@t3tools/contracts";

import { type RenderedWebhookPrompt, renderTemplate } from "../scheduledTasks/webhookTemplate.ts";
import { gitlabTriggerKey } from "./gitlabTriggerSource.ts";
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
