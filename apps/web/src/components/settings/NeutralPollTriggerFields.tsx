import { T, useGT } from "gt-react";

import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Field } from "./scheduledTaskFields";
import type { DraftState } from "./scheduledTasksSettings.logic";

type NeutralPollDraft = Pick<DraftState, "neutralQuery" | "neutralLabels" | "neutralPollMinutes">;

/**
 * What an issues or pull requests trigger asks its project's trackers or hosts for, and how
 * often. Which trackers and hosts those are is the project's own connections.
 */
export function NeutralPollTriggerFields({
  kind,
  draft,
  onChange,
}: {
  kind: "issues" | "pull_requests";
  draft: NeutralPollDraft;
  onChange: (patch: Partial<NeutralPollDraft>) => void;
}) {
  const gt = useGT();
  return (
    <div className="space-y-4">
      <Field label={gt("Search (optional)")} htmlFor="scheduled-task-neutral-query">
        <Input
          id="scheduled-task-neutral-query"
          placeholder={gt("Free text, such as login")}
          value={draft.neutralQuery}
          onChange={(event) => onChange({ neutralQuery: event.target.value })}
        />
      </Field>
      {kind === "issues" ? (
        <Field
          label={gt("Labels it must carry (optional)")}
          htmlFor="scheduled-task-neutral-labels"
        >
          <Input
            id="scheduled-task-neutral-labels"
            placeholder={gt("bug, agent")}
            value={draft.neutralLabels}
            onChange={(event) => onChange({ neutralLabels: event.target.value })}
          />
        </Field>
      ) : null}
      <div className="flex items-center gap-2">
        <Label htmlFor="scheduled-task-neutral-poll">
          <T>Check every</T>
        </Label>
        <Input
          type="number"
          id="scheduled-task-neutral-poll"
          nativeInput
          min={5}
          step={1}
          className="w-24"
          value={draft.neutralPollMinutes}
          onChange={(event) => onChange({ neutralPollMinutes: event.target.value })}
        />
        <span className="text-xs text-muted-foreground">
          <T>minutes</T>
        </span>
      </div>
    </div>
  );
}
