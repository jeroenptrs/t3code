import {
  MAX_WEBHOOK_FILTERS,
  TRIGGER_EVENT_TYPES,
  TRIGGER_SOURCE_FIELDS,
  TriggerFilter,
  type ScheduledTaskTriage,
  type SourceControlProviderDiscoveryItem,
  type TriggerFilterSourceKind,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { webhookFilterDraftsChanged, type WebhookFilterDraft } from "./scheduledTaskWebhook.ts";

const JIRA_TRIGGER_PROMPT = "Work on Jira issue {{event.key}}: {{event.summary}} ({{event.url}}).";
const GITLAB_TRIGGER_PROMPT =
  "Look at merge request !{{event.number}} in {{event.repository}}: {{event.title}} ({{event.url}}).";

export const DEFAULT_TRIGGER_PROMPT = {
  jira: JIRA_TRIGGER_PROMPT,
  jira_query: JIRA_TRIGGER_PROMPT,
  gitlab: GITLAB_TRIGGER_PROMPT,
  gitlab_projects: GITLAB_TRIGGER_PROMPT,
  slack: "{{event.prompt}}",
  manual: "",
} as const;

/** The GitLab hosts the environment's glab is signed in to, which a GitLab projects trigger polls. */
export function signedInGitLabHosts(
  providers: ReadonlyArray<SourceControlProviderDiscoveryItem>,
): Array<string> {
  const hosts = new Set<string>();
  for (const provider of providers) {
    if (provider.kind !== "gitlab") continue;
    for (const account of provider.auth.accounts ?? []) {
      if (account.authenticated) hosts.add(account.host);
    }
    if (provider.auth.status === "authenticated" && Option.isSome(provider.auth.host)) {
      hosts.add(provider.auth.host.value);
    }
  }
  return [...hosts];
}

/** Same row shape as a webhook filter; the path is an `event.` field of the source. */
export type TriggerFilterDraft = WebhookFilterDraft;

let lastTriggerFilterDraftId = 0;
const nextTriggerFilterDraftId = () => `trigger-filter-${++lastTriggerFilterDraftId}`;

export function emptyTriggerFilterDraft(source: TriggerFilterSourceKind): TriggerFilterDraft {
  return {
    id: nextTriggerFilterDraftId(),
    path: TRIGGER_SOURCE_FIELDS[source][0].path,
    op: "equals",
    value: "",
  };
}

export function triggerFilterDrafts(
  filters: ReadonlyArray<TriggerFilter> | undefined,
): ReadonlyArray<TriggerFilterDraft> {
  return (filters ?? []).map((filter) => ({
    id: nextTriggerFilterDraftId(),
    path: filter.path,
    op: filter.op,
    value:
      filter.op === "exists" ? "" : filter.op === "in" ? filter.value.join(", ") : filter.value,
  }));
}

const decodeFilter = Schema.decodeUnknownOption(TriggerFilter);

/** Checks each row with the server's schema and the source's field list, naming the first bad row. */
export function parseTriggerFilterDrafts(
  drafts: ReadonlyArray<TriggerFilterDraft>,
  source: TriggerFilterSourceKind,
): { readonly filters: ReadonlyArray<TriggerFilter> } | { readonly error: string } {
  if (drafts.length > MAX_WEBHOOK_FILTERS) {
    return { error: `Use at most ${MAX_WEBHOOK_FILTERS} filters.` };
  }
  const fields = new Set<string>(TRIGGER_SOURCE_FIELDS[source].map((field) => field.path));
  const filters: TriggerFilter[] = [];
  for (const [index, draft] of drafts.entries()) {
    const path = draft.path.trim();
    if (!fields.has(path)) {
      return { error: `Filter ${index + 1} needs a field this source has.` };
    }
    const filter = decodeFilter(
      draft.op === "exists"
        ? { path, op: draft.op }
        : draft.op === "in"
          ? {
              path,
              op: draft.op,
              value: draft.value
                .split(",")
                .map((item) => item.trim())
                .filter((item) => item !== ""),
            }
          : { path, op: draft.op, value: draft.value },
    );
    if (Option.isNone(filter)) {
      return {
        error: `Filter ${index + 1} needs ${draft.op === "in" ? "at least one value" : "a value"}.`,
      };
    }
    filters.push(filter.value);
  }
  return { filters };
}

export const triggerFilterDraftsChanged = webhookFilterDraftsChanged;

export type TriageFallbackDraft = "off" | ScheduledTaskTriage["fallback"];

export interface TriageDraft {
  readonly fallback: TriageFallbackDraft;
  readonly label: string;
  /** The triage the form opened with. */
  readonly saved: ScheduledTaskTriage | null;
}

export const TRIAGE_FALLBACK_OPTIONS: ReadonlyArray<{
  readonly value: TriageFallbackDraft;
  readonly label: string;
}> = [
  { value: "off", label: "Off" },
  { value: "ask", label: "Ask and wait" },
  { value: "label", label: "Add a label and stop" },
  { value: "stop", label: "Stop" },
];

export function triageDraft(triage: ScheduledTaskTriage | undefined): TriageDraft {
  return {
    fallback: triage?.fallback ?? "off",
    label: triage?.label ?? "",
    saved: triage ?? null,
  };
}

/** The upsert's `triage` field: left out when unchanged so the server keeps it, null to clear. */
export function parseTriageDraft(
  draft: TriageDraft,
): { readonly triage?: ScheduledTaskTriage | null } | { readonly error: string } {
  const label = draft.label.trim();
  if (draft.fallback === "label" && !label) return { error: "Enter the label to add." };
  const triage: ScheduledTaskTriage | null =
    draft.fallback === "off"
      ? null
      : draft.fallback === "label"
        ? { fallback: "label", label }
        : { fallback: draft.fallback };
  const unchanged =
    triage?.fallback === draft.saved?.fallback && triage?.label === draft.saved?.label;
  return unchanged ? {} : { triage };
}

const EVENT_TYPE_PATH = "event.type";

/** The types the "Act on" picker offers; null for a source with one type. */
export function triggerEventTypes(source: string): ReadonlyArray<string> | null {
  return source === "jira" ||
    source === "gitlab" ||
    source === "jira_query" ||
    source === "gitlab_projects"
    ? TRIGGER_EVENT_TYPES[source]
    : null;
}

/**
 * Takes the first `event.type in` filter out for the picker when it names only types the source
 * has; every type when there is none. Other filters, a type `equals` included, stay as they are.
 */
export function splitEventTypeFilter<
  F extends { readonly path: string; readonly op: string; readonly value?: unknown },
>(
  source: string,
  filters: ReadonlyArray<F>,
): { readonly eventTypes: ReadonlyArray<string>; readonly filters: ReadonlyArray<F> } {
  const types: ReadonlyArray<string> = triggerEventTypes(source) ?? [];
  const pickedTypes = (filter: F) =>
    filter.path === EVENT_TYPE_PATH &&
    filter.op === "in" &&
    Array.isArray(filter.value) &&
    filter.value.every((value) => types.includes(value))
      ? (filter.value as ReadonlyArray<string>)
      : null;
  const index = filters.findIndex((filter) => pickedTypes(filter) !== null);
  const picked = index === -1 ? null : pickedTypes(filters[index]!);
  if (picked === null) return { eventTypes: types, filters };
  return {
    eventTypes: types.filter((type) => picked.includes(type)),
    filters: filters.filter((_, at) => at !== index),
  };
}

/** The rows a save sends: a partial choice as an `event.type in` row first, every type as none. */
export function withEventTypeDrafts(
  source: string,
  eventTypes: ReadonlyArray<string>,
  drafts: ReadonlyArray<TriggerFilterDraft>,
): ReadonlyArray<TriggerFilterDraft> {
  const types = triggerEventTypes(source);
  if (types === null || types.every((type) => eventTypes.includes(type))) return drafts;
  const value = types.filter((type) => eventTypes.includes(type)).join(", ");
  return [{ id: nextTriggerFilterDraftId(), path: EVENT_TYPE_PATH, op: "in", value }, ...drafts];
}

const FILTER_PHRASES = {
  equals: ["equals", "has"],
  notEquals: ["is not", "lacks"],
  startsWith: ["starts with", "has an item starting with"],
  in: ["is one of", "has any of"],
  exists: ["is set", "is not empty"],
} as const satisfies Record<TriggerFilter["op"], readonly [string, string]>;

const SUMMARIZED_FILTERS = 2;

/**
 * Filters as a row reads them, such as "Act on issue.entered · Status equals In Progress, Labels
 * has bug".
 */
export function triggerFiltersSummary(
  source: TriggerFilterSourceKind,
  allFilters: ReadonlyArray<TriggerFilter>,
): string {
  const types = triggerEventTypes(source);
  const split = splitEventTypeFilter(source, allFilters);
  const filters = split.filters;
  const actOn =
    types !== null && split.eventTypes.length < types.length
      ? `Act on ${split.eventTypes.join(", ")}`
      : null;
  const fields: ReadonlyArray<{ path: string; label: string; array?: true }> =
    TRIGGER_SOURCE_FIELDS[source];
  const phrases = filters.slice(0, SUMMARIZED_FILTERS).map((filter) => {
    const field = fields.find((entry) => entry.path === filter.path);
    const label = field?.label ?? filter.path.slice("event.".length);
    const verb = FILTER_PHRASES[filter.op][field?.array ? 1 : 0];
    if (filter.op === "exists") return `${label} ${verb}`;
    return `${label} ${verb} ${filter.op === "in" ? filter.value.join(", ") : filter.value}`;
  });
  const more = filters.length - SUMMARIZED_FILTERS;
  const rest = more > 0 ? `${phrases.join(", ")}, +${more} more` : phrases.join(", ");
  return [actOn, rest].filter((part) => part !== null && part !== "").join(" · ");
}
