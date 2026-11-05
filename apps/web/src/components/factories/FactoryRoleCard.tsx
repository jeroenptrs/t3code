import type {
  EnvironmentId,
  FactoryIsolation,
  FactoryIssue,
  FactoryRole,
  FactorySkill,
  ModelSelection,
  ProviderInteractionMode,
  ProviderInstanceId,
  RuntimeMode,
  ServerProvider,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { useId, type ReactNode } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { FactoryFieldIssues } from "./FactoryIssues";
import { issuesFor, type FactoryRoleDraft } from "./FactoryPage.logic";

const FACTORY_ROLE_LABEL = {
  foreman: "Foreman",
  implement: "Implement",
  review: "Review",
} as const;

const INTERACTION_MODE_LABEL: Record<ProviderInteractionMode, string> = {
  default: "Build",
  plan: "Plan",
};

const ISOLATION_LABEL: Record<FactoryIsolation, string> = {
  shared: "Project checkout",
  worktree: "Own worktree",
};

export interface FactoryModelChoices {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /** What a role switched off the project default starts with; null when nothing is available. */
  readonly fallback: ModelSelection | null;
}

function modelLabel(model: ModelSelection | null, entries: ReadonlyArray<ProviderInstanceEntry>) {
  if (model === null) return "Project default";
  const entry = entries.find((candidate) => candidate.instanceId === model.instanceId);
  const name = entry?.models.find((candidate) => candidate.slug === model.model)?.name;
  return `${entry?.displayName ?? model.instanceId} · ${name ?? model.model}`;
}

/** Each skill the role binds that exists, with where it comes from. */
function SkillList(props: { readonly skills: ReadonlyArray<FactorySkill> }) {
  if (props.skills.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1.5">
      {props.skills.map((skill) => (
        <li key={skill.name} className="flex items-center gap-1.5 text-sm">
          {skill.name}
          <Badge variant="outline">
            {skill.source === "file" ? `skills/${skill.name}` : "Built-in"}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function BindingField(props: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly issues: ReadonlyArray<FactoryIssue>;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={props.htmlFor}>{props.label}</Label>
      {props.children}
      <FactoryFieldIssues issues={props.issues} />
    </div>
  );
}

function ChoiceField<Value extends string>(props: {
  readonly label: string;
  readonly value: Value;
  readonly labels: Readonly<Record<Value, string>>;
  readonly editable: boolean;
  readonly disabled: boolean;
  readonly issues: ReadonlyArray<FactoryIssue>;
  readonly onChange: (value: Value) => void;
}) {
  const options = Object.keys(props.labels) as Value[];
  return (
    <BindingField label={props.label} issues={props.issues}>
      {props.editable ? (
        <Select
          value={props.value}
          onValueChange={(value) => {
            if (value !== null) props.onChange(value);
          }}
          items={options.map((value) => ({ value, label: props.labels[value] }))}
        >
          <SelectTrigger size="sm" aria-label={props.label} disabled={props.disabled}>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {options.map((value) => (
              <SelectItem key={value} value={value}>
                {props.labels[value]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : (
        <span className="text-sm">{props.labels[props.value]}</span>
      )}
    </BindingField>
  );
}

const RUNTIME_MODE_LABEL = Object.fromEntries(
  runtimeModeOptions.map((mode) => [mode, runtimeModeConfig[mode].label]),
) as Record<RuntimeMode, string>;

/**
 * One role: where its instructions come from, its bindings once its file is laid over the
 * built-in role, and its instructions. Administrators edit the role file in place.
 */
export function FactoryRoleCard(props: {
  readonly environmentId: EnvironmentId;
  readonly role: FactoryRole;
  readonly draft: FactoryRoleDraft;
  readonly editable: boolean;
  readonly disabled: boolean;
  readonly issues: ReadonlyArray<FactoryIssue>;
  readonly models: FactoryModelChoices;
  readonly onChange: (draft: FactoryRoleDraft) => void;
}) {
  const id = useId();
  const { role, draft, editable, disabled } = props;
  const name = role.role;
  const filePath = role.path ?? `roles/${name}.md`;

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-4 rounded-xl border bg-card p-4 text-card-foreground"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 id={`${id}-title`} className="font-medium">
          {FACTORY_ROLE_LABEL[name]}
        </h3>
        <Badge variant="outline">{role.source === "file" ? filePath : "Built-in"}</Badge>
        {role.source === "file" && role.bodySource === "builtin" ? (
          <span className="text-xs text-muted-foreground">Built-in instructions</span>
        ) : null}
        {editable && role.source === "file" ? (
          <Button
            className="ms-auto"
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => props.onChange({ ...draft, useBuiltin: !draft.useBuiltin })}
          >
            {draft.useBuiltin ? "Keep role file" : "Use built-in instructions"}
          </Button>
        ) : null}
      </header>
      <FactoryFieldIssues issues={issuesFor(props.issues, name, null)} />
      {draft.useBuiltin ? (
        <p className="text-sm text-muted-foreground">
          Saving deletes {filePath}, so this role uses the built-in bindings and instructions.
        </p>
      ) : (
        <FactoryRoleFields {...props} id={id} />
      )}
    </section>
  );
}

function FactoryRoleFields(props: Parameters<typeof FactoryRoleCard>[0] & { readonly id: string }) {
  const { id, role, draft, editable, disabled, models } = props;
  const name = role.role;
  const effective = role.binding;
  const fieldIssues = (field: string) => issuesFor(props.issues, name, field);
  const setBinding = (binding: FactoryRoleDraft["binding"]) =>
    props.onChange({ ...draft, binding });
  const model = draft.binding.model ?? null;
  const activeInstanceId = model?.instanceId ?? ("" as ProviderInstanceId);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <BindingField label="Model" issues={fieldIssues("model")}>
          {editable ? (
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  size="sm"
                  checked={model === null}
                  disabled={disabled || (model === null && models.fallback === null)}
                  onCheckedChange={(checked) => {
                    const { model: _model, ...rest } = draft.binding;
                    if (checked) setBinding(rest);
                    else if (models.fallback !== null)
                      setBinding({ ...rest, model: models.fallback });
                  }}
                />
                Project default
              </label>
              {model === null ? null : (
                <ProviderModelPicker
                  environmentId={props.environmentId}
                  disabled={disabled}
                  activeInstanceId={activeInstanceId}
                  model={model.model}
                  lockedProvider={null}
                  instanceEntries={models.instanceEntries}
                  modelOptionsByInstance={getCustomModelOptionsByInstance(
                    models.settings,
                    models.providers,
                    activeInstanceId,
                    model.model,
                  )}
                  isComposerOwned={false}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onInstanceModelChange={(instanceId, slug) =>
                    setBinding({ ...draft.binding, model: { instanceId, model: slug } })
                  }
                />
              )}
            </div>
          ) : (
            <span className="text-sm">{modelLabel(effective.model, models.instanceEntries)}</span>
          )}
        </BindingField>
        <ChoiceField
          label="Runtime mode"
          value={draft.binding.runtimeMode ?? effective.runtimeMode}
          labels={RUNTIME_MODE_LABEL}
          editable={editable}
          disabled={disabled}
          issues={fieldIssues("runtimeMode")}
          onChange={(runtimeMode) => setBinding({ ...draft.binding, runtimeMode })}
        />
        <ChoiceField
          label="Interaction mode"
          value={draft.binding.interactionMode ?? effective.interactionMode}
          labels={INTERACTION_MODE_LABEL}
          editable={editable}
          disabled={disabled}
          issues={fieldIssues("interactionMode")}
          onChange={(interactionMode) => setBinding({ ...draft.binding, interactionMode })}
        />
        <ChoiceField
          label="Works in"
          value={draft.binding.isolation ?? effective.isolation}
          labels={ISOLATION_LABEL}
          editable={editable}
          disabled={disabled}
          issues={fieldIssues("isolation")}
          onChange={(isolation) => setBinding({ ...draft.binding, isolation })}
        />
        <BindingField label="Skills" htmlFor={`${id}-skills`} issues={fieldIssues("skills")}>
          {editable ? (
            <Input
              id={`${id}-skills`}
              size="sm"
              value={draft.skills}
              disabled={disabled}
              placeholder={effective.skills.join(", ") || "None"}
              onChange={(event) => props.onChange({ ...draft, skills: event.target.value })}
            />
          ) : role.skills.length === 0 ? (
            <span className="text-sm">None</span>
          ) : null}
          <SkillList skills={role.skills} />
        </BindingField>
        <BindingField label="Tools" htmlFor={`${id}-tools`} issues={fieldIssues("tools")}>
          {editable ? (
            <Input
              id={`${id}-tools`}
              size="sm"
              value={draft.tools}
              disabled={disabled}
              placeholder={effective.tools.join(", ") || "Any tool"}
              onChange={(event) => props.onChange({ ...draft, tools: event.target.value })}
            />
          ) : (
            <span className="text-sm">{effective.tools.join(", ") || "Any tool"}</span>
          )}
        </BindingField>
      </div>

      <BindingField label="Instructions" htmlFor={`${id}-body`} issues={fieldIssues("body")}>
        {editable ? (
          <Textarea
            id={`${id}-body`}
            className="max-h-96 overflow-y-auto"
            value={draft.body}
            placeholder="Blank uses the built-in instructions."
            disabled={disabled}
            onChange={(event) => props.onChange({ ...draft, body: event.target.value })}
          />
        ) : (
          <pre className="max-h-96 overflow-y-auto rounded-lg bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
            {role.body}
          </pre>
        )}
      </BindingField>
    </>
  );
}
