import type { TriggerEvent, TriggerFilter } from "@t3tools/contracts";

import { type FailedWebhookFilter, findFailedFilter } from "../scheduledTasks/webhookFilter.ts";

const EVENT_PREFIX = "event.";

/** Reads `event.<field>` from the event's flat payload; anything else is missing. */
export function triggerFieldResolver(event: TriggerEvent): (path: string) => unknown {
  const payload: Readonly<Record<string, unknown>> = event.payload;
  return (path) => {
    if (!path.startsWith(EVENT_PREFIX)) return undefined;
    const field = path.slice(EVENT_PREFIX.length);
    return Object.hasOwn(payload, field) ? payload[field] : undefined;
  };
}

/** Payload arrays always match per element, so trigger paths carry no `[]`. */
export function findFailedTriggerFilter(
  filters: ReadonlyArray<TriggerFilter>,
  event: TriggerEvent,
): FailedWebhookFilter | null {
  return findFailedFilter(filters, triggerFieldResolver(event), { matchesAnyElement: () => true });
}
