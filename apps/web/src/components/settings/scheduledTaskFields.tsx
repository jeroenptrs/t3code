import {
  MAX_WEBHOOK_FILTERS,
  TRIGGER_SOURCE_FIELDS,
  type TriggerFilterSourceKind,
} from "@t3tools/contracts";
import {
  emptyTriggerFilterDraft,
  TRIAGE_FALLBACK_OPTIONS,
  type TriageDraft,
  type TriggerFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-trigger";
import {
  emptyWebhookFilterDraft,
  removeWebhookFilterDraft,
  WEBHOOK_FILTER_OPS,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
import { PlusIcon, Trash2Icon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80">{hint}</span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}

const PROMPT_EXAMPLES: Record<TriggerFilterSourceKind, readonly [string, string]> = {
  jira: ["{{event.key}}", "{{event.summary}}"],
  gitlab: ["{{event.title}}", "{{event.url}}"],
  slack: ["{{event.prompt}}", "{{event.surface}}"],
};

/** Shown under the prompt for event sources. */
export function TriggerPromptHint({ source }: { source: TriggerFilterSourceKind }) {
  const [first, second] = PROMPT_EXAMPLES[source];
  return (
    <p className="text-xs text-muted-foreground">
      {`Use {{event.<field>}} in the prompt, such as ${first} or ${second}. {{event}} sends every field.`}
    </p>
  );
}

function FilterOpSelect({
  index,
  op,
  onChange,
}: {
  index: number;
  op: WebhookFilterDraft["op"];
  onChange: (op: WebhookFilterDraft["op"]) => void;
}) {
  return (
    <Select
      value={op}
      onValueChange={(next) => {
        const known = WEBHOOK_FILTER_OPS.find((option) => option.op === next);
        if (known) onChange(known.op);
      }}
    >
      <div className="grid w-44 shrink-0 grid-cols-1">
        <SelectTrigger size="sm" aria-label={`Filter ${index + 1} test`}>
          <SelectValue>{WEBHOOK_FILTER_OPS.find((option) => option.op === op)?.label}</SelectValue>
        </SelectTrigger>
      </div>
      <SelectPopup>
        {WEBHOOK_FILTER_OPS.map((option) => (
          <SelectItem key={option.op} value={option.op}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function FilterValueInput({
  index,
  filter,
  placeholder,
  onChange,
}: {
  index: number;
  filter: WebhookFilterDraft;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  if (filter.op === "exists") return null;
  return (
    <div className="grid min-w-0 flex-1 grid-cols-1">
      <Input
        aria-label={`Filter ${index + 1} value`}
        placeholder={placeholder}
        value={filter.value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function FiltersHeader({
  description,
  canAdd,
  onAdd,
}: {
  description: string;
  canAdd: boolean;
  onAdd: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0 space-y-1">
        <Label>Filters</Label>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Button className="shrink-0" variant="outline" size="sm" disabled={!canAdd} onClick={onAdd}>
        <PlusIcon />
        Add filter
      </Button>
    </div>
  );
}

export function WebhookFiltersField({
  filters,
  onChange,
}: {
  filters: ReadonlyArray<WebhookFilterDraft>;
  onChange: (filters: ReadonlyArray<WebhookFilterDraft>) => void;
}) {
  const update = (index: number, patch: Partial<WebhookFilterDraft>) =>
    onChange(filters.map((filter, at) => (at === index ? { ...filter, ...patch } : filter)));
  return (
    <div className="space-y-2">
      <FiltersHeader
        description="Run only when every filter matches. Other requests are logged as filtered. Separate “is one of” values with commas; a value can't contain a comma."
        canAdd={filters.length < MAX_WEBHOOK_FILTERS}
        onAdd={() => onChange([...filters, emptyWebhookFilterDraft()])}
      />
      {filters.map((filter, index) => (
        // Always stacked: the dialog stays narrow on wide windows, so a single line
        // would cut off typical paths and values. The grid wrappers size each control
        // without restyling it; a grid item stretches to its minmax(0, 1fr) track.
        <div key={filter.id} className="space-y-2 pt-1">
          <div className="flex items-center gap-2">
            <div className="grid min-w-0 flex-1 grid-cols-1">
              <Input
                aria-label={`Filter ${index + 1} path`}
                placeholder="body.action"
                value={filter.path}
                onChange={(event) => update(index, { path: event.target.value })}
              />
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove filter ${index + 1}`}
              onClick={() => onChange(removeWebhookFilterDraft(filters, filter.id))}
            >
              <Trash2Icon />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <FilterOpSelect index={index} op={filter.op} onChange={(op) => update(index, { op })} />
            <FilterValueInput
              index={index}
              filter={filter}
              placeholder={filter.op === "in" ? "opened, reopened" : "opened"}
              onChange={(value) => update(index, { value })}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Filters over one event source's fields, picked from the fields that source sends. */
export function TriggerFiltersField({
  source,
  filters,
  onChange,
}: {
  source: TriggerFilterSourceKind;
  filters: ReadonlyArray<TriggerFilterDraft>;
  onChange: (filters: ReadonlyArray<TriggerFilterDraft>) => void;
}) {
  const fields: ReadonlyArray<{
    readonly path: string;
    readonly label: string;
    readonly description: string;
    readonly array?: true;
  }> = TRIGGER_SOURCE_FIELDS[source];
  const update = (index: number, patch: Partial<TriggerFilterDraft>) =>
    onChange(filters.map((filter, at) => (at === index ? { ...filter, ...patch } : filter)));
  const hasLists = fields.some((field) => field.array);
  return (
    <div className="space-y-2">
      <FiltersHeader
        description={`Run only when every filter matches. Separate “is one of” values with commas; a value can't contain a comma.${
          hasLists ? " A list field, such as labels, matches when any item does." : ""
        }`}
        canAdd={filters.length < MAX_WEBHOOK_FILTERS}
        onAdd={() => onChange([...filters, emptyTriggerFilterDraft(source)])}
      />
      {filters.map((filter, index) => {
        const field = fields.find((entry) => entry.path === filter.path);
        return (
          <div key={filter.id} className="space-y-2 pt-1">
            <div className="flex items-center gap-2">
              <Select
                value={filter.path}
                onValueChange={(path) => {
                  if (path) update(index, { path });
                }}
              >
                <div className="grid min-w-0 flex-1 grid-cols-1">
                  <SelectTrigger size="sm" aria-label={`Filter ${index + 1} field`}>
                    <SelectValue>{field?.label ?? filter.path}</SelectValue>
                  </SelectTrigger>
                </div>
                <SelectPopup>
                  {fields.map((entry) => (
                    <SelectItem key={entry.path} value={entry.path} label={entry.label}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove filter ${index + 1}`}
                onClick={() => onChange(removeWebhookFilterDraft(filters, filter.id))}
              >
                <Trash2Icon />
              </Button>
            </div>
            {field ? <p className="text-xs text-muted-foreground">{field.description}</p> : null}
            <div className="flex items-center gap-2">
              <FilterOpSelect
                index={index}
                op={filter.op}
                onChange={(op) => update(index, { op })}
              />
              <FilterValueInput
                index={index}
                filter={filter}
                placeholder={filter.op === "in" ? "first, second" : "Value"}
                onChange={(value) => update(index, { value })}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function TriageField({
  triage,
  onChange,
}: {
  triage: TriageDraft;
  onChange: (triage: TriageDraft) => void;
}) {
  return (
    <div className="space-y-3">
      <Field
        label="When the item fits no instruction"
        hint="triage"
        htmlFor="scheduled-task-triage"
      >
        <Select
          value={triage.fallback}
          onValueChange={(value) => {
            const option = TRIAGE_FALLBACK_OPTIONS.find((entry) => entry.value === value);
            if (option) onChange({ ...triage, fallback: option.value });
          }}
        >
          <SelectTrigger
            size="sm"
            id="scheduled-task-triage"
            aria-label="When the item fits no instruction"
          >
            <SelectValue>
              {TRIAGE_FALLBACK_OPTIONS.find((entry) => entry.value === triage.fallback)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {TRIAGE_FALLBACK_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <p className="text-xs text-muted-foreground">
          Adds triage instructions to every run. Off sends the prompt as written.
        </p>
      </Field>
      {triage.fallback === "label" ? (
        <Field label="Label to add" htmlFor="scheduled-task-triage-label">
          <Input
            id="scheduled-task-triage-label"
            placeholder="needs-triage"
            required
            value={triage.label}
            onChange={(event) => onChange({ ...triage, label: event.target.value })}
          />
        </Field>
      ) : null}
    </div>
  );
}
