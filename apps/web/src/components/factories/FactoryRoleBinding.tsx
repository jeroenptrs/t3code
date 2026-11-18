import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  Factory,
  FactoryEffectiveBinding,
  FactoryIsolation,
  FactoryIssue,
  ModelSelection,
  ProviderInteractionMode,
  ProviderInstanceId,
  RuntimeMode,
  ServerProvider,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { msg, useGT, useMessages } from "gt-react";
import type { ReactNode } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import type { MessageResolver } from "../../i18n/messages";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor, type ProviderInstanceEntry } from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { FactoryFieldIssues } from "./FactoryIssues";
import { issuesFor } from "./FactoryPage.logic";
import type { RoleBindingDraft } from "./FactoryRoles.logic";

const INTERACTION_MODE_LABEL: Record<ProviderInteractionMode, string> = {
  default: msg("Build", { $context: "interaction mode, the agent makes changes" }),
  plan: msg("Plan", { $context: "interaction mode, the agent only plans" }),
};

const ISOLATION_LABEL: Record<FactoryIsolation, string> = {
  shared: msg("Project checkout"),
  worktree: msg("Own worktree"),
};

const RUNTIME_MODE_LABEL = Object.fromEntries(
  runtimeModeOptions.map((mode) => [mode, runtimeModeConfig[mode].label]),
) as Record<RuntimeMode, string>;

export interface FactoryModelChoices {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /** What a role switched off the project default starts with; null when nothing is available. */
  readonly fallback: ModelSelection | null;
}

export function useFactoryModelChoices(
  environmentId: EnvironmentId,
  factory: Pick<Factory, "projectId">,
): FactoryModelChoices {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const project =
    useProjects().find(
      (candidate) =>
        candidate.environmentId === environmentId && candidate.id === factory.projectId,
    ) ?? null;
  const instanceEntries = providerInstanceEntriesFor(providers, settings, factory.projectId);
  return {
    providers,
    settings,
    instanceEntries,
    fallback: scheduledTaskDefaultModel(settings, project, instanceEntries),
  };
}

/** The model a role runs, by its name where the provider lists it. */
export function factoryModelLabel(
  model: ModelSelection | null,
  entries: ReadonlyArray<ProviderInstanceEntry>,
  resolve: MessageResolver,
): string {
  if (model === null) return resolve(msg("Project default", { $context: "model" }));
  const entry = entries.find((candidate) => candidate.instanceId === model.instanceId);
  return entry?.models.find((candidate) => candidate.slug === model.model)?.name ?? model.model;
}

function BindingField(props: {
  readonly label: string;
  readonly issues: ReadonlyArray<FactoryIssue>;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label>{props.label}</Label>
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
  const messages = useMessages();
  const options = Object.keys(props.labels) as Value[];
  return (
    <BindingField label={props.label} issues={props.issues}>
      {props.editable ? (
        <Select
          value={props.value}
          onValueChange={(value) => {
            if (value !== null) props.onChange(value);
          }}
          items={options.map((value) => ({ value, label: messages(props.labels[value]) }))}
        >
          <SelectTrigger size="sm" aria-label={props.label} disabled={props.disabled}>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {options.map((value) => (
              <SelectItem key={value} value={value}>
                {messages(props.labels[value])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : (
        <span className="text-sm">{messages(props.labels[props.value])}</span>
      )}
    </BindingField>
  );
}

type FactoryBindingField = "model" | "runtimeMode" | "interactionMode" | "isolation";

const ALL_FIELDS: ReadonlyArray<FactoryBindingField> = [
  "model",
  "runtimeMode",
  "interactionMode",
  "isolation",
];

/**
 * A role's model, runtime mode, interaction mode, and where it works: the role file's own value,
 * or the role's default where the file sets none. The role page and the Foreman card share it.
 */
export function FactoryBindingFields(props: {
  readonly environmentId: EnvironmentId;
  readonly role: string;
  readonly effective: FactoryEffectiveBinding;
  readonly binding: RoleBindingDraft;
  readonly fields?: ReadonlyArray<FactoryBindingField>;
  readonly editable: boolean;
  readonly disabled: boolean;
  readonly issues: ReadonlyArray<FactoryIssue>;
  readonly models: FactoryModelChoices;
  readonly onChange: (binding: RoleBindingDraft) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { binding, effective, editable, disabled, models } = props;
  const fields = props.fields ?? ALL_FIELDS;
  const fieldIssues = (field: string) => issuesFor(props.issues, props.role, field);
  const model = binding.model ?? null;
  const activeInstanceId = model?.instanceId ?? ("" as ProviderInstanceId);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {fields.includes("model") ? (
        <BindingField label={gt("Model")} issues={fieldIssues("model")}>
          {editable ? (
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  size="sm"
                  checked={model === null}
                  disabled={disabled || (model === null && models.fallback === null)}
                  onCheckedChange={(checked) => {
                    const { model: _model, ...rest } = binding;
                    if (checked) props.onChange(rest);
                    else if (models.fallback !== null)
                      props.onChange({ ...rest, model: models.fallback });
                  }}
                />
                {gt("Project default", { $context: "model" })}
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
                    props.onChange({ ...binding, model: { instanceId, model: slug } })
                  }
                />
              )}
            </div>
          ) : (
            <span className="text-sm">
              {factoryModelLabel(effective.model, models.instanceEntries, messages)}
            </span>
          )}
        </BindingField>
      ) : null}
      {fields.includes("runtimeMode") ? (
        <ChoiceField
          label={gt("Runtime mode")}
          value={binding.runtimeMode ?? effective.runtimeMode}
          labels={RUNTIME_MODE_LABEL}
          editable={editable}
          disabled={disabled}
          issues={fieldIssues("runtimeMode")}
          onChange={(runtimeMode) => props.onChange({ ...binding, runtimeMode })}
        />
      ) : null}
      {fields.includes("interactionMode") ? (
        <ChoiceField
          label={gt("Interaction mode")}
          value={binding.interactionMode ?? effective.interactionMode}
          labels={INTERACTION_MODE_LABEL}
          editable={editable}
          disabled={disabled}
          issues={fieldIssues("interactionMode")}
          onChange={(interactionMode) => props.onChange({ ...binding, interactionMode })}
        />
      ) : null}
      {fields.includes("isolation") ? (
        <ChoiceField
          label={gt("Works in")}
          value={binding.isolation ?? effective.isolation}
          labels={ISOLATION_LABEL}
          editable={editable}
          disabled={disabled}
          issues={fieldIssues("isolation")}
          onChange={(isolation) => props.onChange({ ...binding, isolation })}
        />
      ) : null}
    </div>
  );
}
