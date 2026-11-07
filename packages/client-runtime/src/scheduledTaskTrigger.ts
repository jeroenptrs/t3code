import {
  MAX_WEBHOOK_FILTERS,
  TRIGGER_SOURCE_FIELDS,
  TriggerFilter,
  type ScheduledTaskTriage,
  type TriggerFilterSourceKind,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { webhookFilterDraftsChanged, type WebhookFilterDraft } from "./scheduledTaskWebhook.ts";

const JIRA_TRIGGER_PROMPT = "Work on Jira issue {{event.key}}: {{event.summary}} ({{event.url}}).";

export const DEFAULT_TRIGGER_PROMPT = {
  jira: JIRA_TRIGGER_PROMPT,
  jira_query: JIRA_TRIGGER_PROMPT,
  gitlab:
    "Look at merge request !{{event.number}} in {{event.repository}}: {{event.title}} ({{event.url}}).",
  slack: "{{event.prompt}}",
  manual: "",
} as const;

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

const FILTER_PHRASES = {
  equals: ["equals", "has"],
  notEquals: ["is not", "lacks"],
  startsWith: ["starts with", "has an item starting with"],
  in: ["is one of", "has any of"],
  exists: ["is set", "is not empty"],
} as const satisfies Record<TriggerFilter["op"], readonly [string, string]>;

const SUMMARIZED_FILTERS = 2;

/** Filters as a row reads them, such as "Status equals In Progress, Labels has bug". */
export function triggerFiltersSummary(
  source: TriggerFilterSourceKind,
  filters: ReadonlyArray<TriggerFilter>,
): string {
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
  return more > 0 ? `${phrases.join(", ")}, +${more} more` : phrases.join(", ");
}
