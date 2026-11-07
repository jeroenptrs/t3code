import {
  TriggerTemplateName,
  TriggerTemplatePlaceholder,
  type ProjectId,
  type TriggerSourceKind,
  type TriggerTemplate,
  type TriggerTemplateFilter,
} from "@t3tools/contracts";
import {
  parseTriggerFilterDrafts,
  triggerFilterDrafts,
  type TriggerFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-trigger";
import {
  parseWebhookFilterDrafts,
  webhookFilterDrafts,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isTriggerFilterSource, type DraftState } from "./scheduledTasksSettings.logic";

export const TRIGGER_SOURCE_LABELS: Record<TriggerSourceKind, string> = {
  schedule: "Schedule",
  webhook: "Webhook",
  jira: "Jira",
  gitlab: "GitLab",
  slack: "Slack",
  manual: "Manual",
  jira_query: "Jira query",
  gitlab_projects: "GitLab projects",
};

interface PlaceholderDraft {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly default: string;
}

export interface TemplateDraft {
  /** Null for a new template; a saved template keeps its name, which is its file name. */
  readonly savedName: string | null;
  readonly name: string;
  readonly title: string;
  readonly source: TriggerSourceKind;
  readonly webhookFilters: ReadonlyArray<WebhookFilterDraft>;
  readonly triggerFilters: ReadonlyArray<TriggerFilterDraft>;
  readonly placeholders: ReadonlyArray<PlaceholderDraft>;
  readonly prompt: string;
}

let lastPlaceholderDraftId = 0;
export const emptyPlaceholderDraft = (): PlaceholderDraft => ({
  id: `placeholder-${++lastPlaceholderDraftId}`,
  name: "",
  description: "",
  default: "",
});

export function templateToDraft(template: TriggerTemplate | null): TemplateDraft {
  if (template === null) {
    return {
      savedName: null,
      name: "",
      title: "",
      source: "jira",
      webhookFilters: [],
      triggerFilters: [],
      placeholders: [],
      prompt: "",
    };
  }
  return {
    savedName: template.name,
    name: template.name,
    title: template.title,
    source: template.source,
    webhookFilters: template.source === "webhook" ? webhookFilterDrafts(template.filters) : [],
    triggerFilters: isTriggerFilterSource(template.source)
      ? triggerFilterDrafts(template.filters)
      : [],
    placeholders: template.placeholders.map((placeholder) => ({
      ...emptyPlaceholderDraft(),
      name: placeholder.name,
      description: placeholder.description ?? "",
      default: placeholder.default ?? "",
    })),
    prompt: template.prompt,
  };
}

const isTemplateName = Schema.is(TriggerTemplateName);
const decodePlaceholder = Schema.decodeUnknownOption(TriggerTemplatePlaceholder);

/** Builds the template to save, or names the first field that would not save. */
export function templateFromDraft(
  draft: TemplateDraft,
): { readonly template: TriggerTemplate } | { readonly error: string } {
  const name = draft.name.trim();
  if (!isTemplateName(name))
    return {
      error:
        "Name the template with lowercase letters, digits, and dashes, starting with a letter or digit.",
    };
  const title = draft.title.trim();
  if (!title) return { error: "Add a title." };
  let filters: ReadonlyArray<TriggerTemplateFilter> = [];
  if (draft.source === "webhook") {
    const parsed = parseWebhookFilterDrafts(draft.webhookFilters);
    if ("error" in parsed) return parsed;
    filters = parsed.filters;
  } else if (isTriggerFilterSource(draft.source)) {
    const parsed = parseTriggerFilterDrafts(draft.triggerFilters, draft.source);
    if ("error" in parsed) return parsed;
    filters = parsed.filters;
  }
  const placeholders: TriggerTemplatePlaceholder[] = [];
  const seen = new Set<string>();
  for (const [index, row] of draft.placeholders.entries()) {
    const description = row.description.trim();
    const fallback = row.default.trim();
    const placeholder = decodePlaceholder({
      name: row.name.trim(),
      ...(description ? { description } : {}),
      ...(fallback ? { default: fallback } : {}),
    });
    if (Option.isNone(placeholder) || seen.has(placeholder.value.name))
      return {
        error: `Placeholder ${index + 1} needs a unique name that starts with a lowercase letter and uses only letters, digits, and underscores. event, body, headers, query, and request are taken.`,
      };
    seen.add(placeholder.value.name);
    placeholders.push(placeholder.value);
  }
  return {
    template: { name, title, source: draft.source, filters, prompt: draft.prompt, placeholders },
  };
}

/** The new task fields a filled-in template sets. */
export function taskPrefillFromTemplate(
  template: Pick<TriggerTemplate, "title" | "source">,
  filled: { readonly filters: ReadonlyArray<TriggerTemplateFilter>; readonly prompt: string },
  projectId: ProjectId,
): Partial<DraftState> {
  const { source } = template;
  return {
    title: template.title,
    prompt: filled.prompt,
    projectId,
    scheduleMode: source === "schedule" ? "fixed" : source,
    ...(source === "webhook" ? { filters: webhookFilterDrafts(filled.filters) } : {}),
    ...(isTriggerFilterSource(source)
      ? { triggerFilters: triggerFilterDrafts(filled.filters) }
      : {}),
  };
}
