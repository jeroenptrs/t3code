import {
  MAX_WEBHOOK_FILTERS,
  TRIGGER_SOURCE_FIELDS,
  TriggerFilter,
  type ScheduledTaskTriage,
  type TriggerFilterSourceKind,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  WEBHOOK_FILTER_OPS,
  webhookFilterDraftsChanged,
  type WebhookFilterDraft,
} from "./scheduledTaskWebhook.ts";

export const DEFAULT_TRIGGER_PROMPT = {
  jira: "Work on Jira issue {{event.key}}: {{event.summary}} ({{event.url}}).",
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
