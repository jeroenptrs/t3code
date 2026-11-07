import {
  fillTriggerTemplate,
  type ModelSelection,
  type ProjectId,
  type TriggerTemplate,
} from "@t3tools/contracts";
import { webhookFilterDrafts } from "@t3tools/client-runtime/scheduled-task-webhook";
import { triggerFilterDrafts } from "@t3tools/client-runtime/scheduled-task-trigger";

import { createDraft, DEFAULT_SCHEDULE, type ScheduledTaskDraft } from "./scheduledTaskDraft";

/** A new-task draft from a template, or an error naming the placeholders still unfilled. */
export function scheduledTaskDraftFromTemplate(
  template: TriggerTemplate,
  values: Readonly<Record<string, string>>,
  context: { readonly projectId: ProjectId; readonly modelSelection: ModelSelection | null },
): { readonly draft: ScheduledTaskDraft } | { readonly error: string } {
  const filled = fillTriggerTemplate(template, values);
  if (filled.missing.length > 0) {
    return { error: `Fill in ${filled.missing.join(", ")}.` };
  }
  const base = createDraft(context.projectId, context.modelSelection);
  const { source } = template;
  // Saved rows stay empty: the task is new, so the editor sends every filter.
  const schedule =
    source === "schedule"
      ? DEFAULT_SCHEDULE
      : source === "webhook"
        ? { ...DEFAULT_SCHEDULE, mode: source, filters: webhookFilterDrafts(filled.filters) }
        : source === "manual"
          ? { ...DEFAULT_SCHEDULE, mode: source }
          : {
              ...DEFAULT_SCHEDULE,
              mode: source,
              triggerFilters: triggerFilterDrafts(filled.filters),
            };
  return { draft: { ...base, title: template.title, prompt: filled.prompt, schedule } };
}
