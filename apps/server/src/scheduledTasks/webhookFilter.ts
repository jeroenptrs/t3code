import type { ScheduledTaskWebhookFilter, TriggerFilter } from "@t3tools/contracts";

import { webhookExpressionResolver, type WebhookRequest } from "./webhookTemplate.ts";

export interface FailedWebhookFilter {
  readonly index: number;
  readonly path: string;
}

type Filter = ScheduledTaskWebhookFilter | TriggerFilter;

export interface FilterOptions {
  /** Whether an array at this path matches when any element does, instead of only `exists`. */
  readonly matchesAnyElement: (path: string) => boolean;
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function matchesScalar(filter: Filter, text: string): boolean {
  switch (filter.op) {
    case "equals":
      return text === filter.value;
    case "notEquals":
      return text !== filter.value;
    case "in":
      return filter.value.includes(text);
    case "startsWith":
      return text.startsWith(filter.value);
    case "exists":
      return true;
  }
}

/**
 * Placeholders render null as missing, so filters treat it the same way. An
 * array that matches per element passes `equals`, `in` and `startsWith` when
 * any element does, `notEquals` only when none equals the value, and `exists`
 * when it has an element.
 */
function matchesFilter(filter: Filter, value: unknown, options: FilterOptions): boolean {
  if (Array.isArray(value) && options.matchesAnyElement(filter.path)) {
    if (filter.op === "exists")
      return value.some((element) => element !== null && element !== undefined);
    const texts = value.map(scalarText).filter((text): text is string => text !== undefined);
    if (filter.op === "notEquals") return texts.every((text) => text !== filter.value);
    return texts.some((text) => matchesScalar(filter, text));
  }
  if (filter.op === "exists") return value !== undefined && value !== null;
  const text = scalarText(value);
  if (text === undefined) return false;
  return matchesScalar(filter, text);
}

/** The first filter that fails against `resolve`, or null when every filter matches. */
export function findFailedFilter(
  filters: ReadonlyArray<Filter>,
  resolve: (path: string) => unknown,
  options: FilterOptions,
): FailedWebhookFilter | null {
  for (const [index, filter] of filters.entries()) {
    if (!matchesFilter(filter, resolve(filter.path), options)) return { index, path: filter.path };
  }
  return null;
}

const WEBHOOK_FILTER_OPTIONS: FilterOptions = { matchesAnyElement: (path) => /\[\]/.test(path) };

/** The first filter the request fails, or null when every filter matches. */
export function findFailedWebhookFilter(
  filters: ReadonlyArray<ScheduledTaskWebhookFilter>,
  request: WebhookRequest,
): FailedWebhookFilter | null {
  if (filters.length === 0) return null;
  return findFailedFilter(filters, webhookExpressionResolver(request), WEBHOOK_FILTER_OPTIONS);
}

/** Filters are numbered from 1, in the order the settings form lists them. */
export function describeFailedWebhookFilter(failed: FailedWebhookFilter): string {
  return `Filter ${failed.index + 1} (${failed.path}) did not match.`;
}
