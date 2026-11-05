import { useAtomValue } from "@effect/atom-react";
import {
  fillTriggerTemplate,
  resolveEnvironmentMachineKind,
  TriggerSourceKind,
  type EnvironmentId,
  type ProjectId,
  type TriggerTemplate,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { MoreHorizontalIcon, PencilIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useProjects } from "../../state/entities";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  Field,
  TriggerFiltersField,
  TriggerPromptHint,
  WebhookFiltersField,
} from "./scheduledTaskFields";
import {
  defaultScheduledTaskProjectId,
  isTriggerFilterSource,
  matchesScheduledTaskScope,
  type DraftState,
} from "./scheduledTasksSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  emptyPlaceholderDraft,
  taskPrefillFromTemplate,
  templateFromDraft,
  templateToDraft,
  TRIGGER_SOURCE_LABELS,
  type TemplateDraft,
} from "./triggerTemplates.logic";

const triggerTemplateReadPermissionsAtom = environmentAtomList(
  "web-trigger-template-read-permissions",
  (environmentId) => serverEnvironment.triggerTemplates.permissionAtom(environmentId),
);

const SOURCES = TriggerSourceKind.literals;

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

/** Reusable trigger definitions stored in a project. Operators read them; administrators edit. */
export function TriggerTemplatesSection({
  canCreateTask,
  onUse,
}: {
  readonly canCreateTask: (environmentId: EnvironmentId) => boolean;
  readonly onUse: (environmentId: EnvironmentId, prefill: Partial<DraftState>) => void;
}) {
  const { scope, connectedEnvironments, environment } = useSettingsScope();
  const readPermissions = useAtomValue(
    triggerTemplateReadPermissionsAtom(
      environmentIdsKey(connectedEnvironments.map((entry) => entry.environmentId)),
    ),
  );
  const readable = connectedEnvironments.filter((_entry, index) => readPermissions[index]);
  const [chosenEnvironmentId, setChosenEnvironmentId] = useState<EnvironmentId | null>(null);
  const selectedEnvironment =
    readable.find((entry) => entry.environmentId === chosenEnvironmentId) ??
    readable.find((entry) => entry.environmentId === environment?.environmentId) ??
    readable[0];
  const environmentId = selectedEnvironment?.environmentId ?? null;
  const allProjects = useProjects();
  const projects = allProjects
    .filter(
      (project) =>
        project.environmentId === environmentId &&
        project.archivedAt == null &&
        matchesScheduledTaskScope(scope, project.environmentId, project.id),
    )
    .toSorted((left, right) => Number(right.pinnedAt != null) - Number(left.pinnedAt != null));
  const [chosenProjectId, setChosenProjectId] = useState<ProjectId | null>(null);
  const projectId =
    projects.find((project) => project.id === chosenProjectId)?.id ??
    (defaultScheduledTaskProjectId(projects, scope) || null);
  const selectedProject = projects.find((project) => project.id === projectId);
  const canManage = useAtomValue(
    serverEnvironment.saveTriggerTemplate.permissionAtom(environmentId),
  );
  const templatesQuery = useEnvironmentQuery(
    environmentId !== null && projectId !== null
      ? serverEnvironment.triggerTemplates({ environmentId, input: { projectId } })
      : null,
  );
  const [editing, setEditing] = useState<{ template: TriggerTemplate | null } | null>(null);
  const [using, setUsing] = useState<TriggerTemplate | null>(null);
  const remove = useAtomCommand(serverEnvironment.deleteTriggerTemplate, {
    label: "trigger template delete",
  });

  if (environmentId === null) return null;

  const deleteTemplate = async (template: TriggerTemplate) => {
    if (projectId === null) return;
    const message = `Delete the template ${template.title}?\nTasks made from it keep running.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ??
      window.confirm(message.replace("\n", " "));
    if (!confirmed) return;
    const result = await remove({ environmentId, input: { projectId, name: template.name } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      reportFailure("Could not delete template", squashAtomCommandFailure(result));
  };
  const applyTemplate = (template: TriggerTemplate, values: Readonly<Record<string, string>>) => {
    if (projectId === null) return;
    const filled = fillTriggerTemplate(template, values);
    setUsing(null);
    onUse(environmentId, taskPrefillFromTemplate(template, filled, projectId));
  };
  const templates = templatesQuery.data?.templates;

  return (
    <SettingsSection
      title="Trigger templates"
      variant="plain"
      headerAction={
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!canManage || projectId === null}
          onClick={() => setEditing({ template: null })}
        >
          <PlusIcon className="size-3" />
          New template
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        {readable.length > 1 ? (
          <Select
            value={environmentId}
            onValueChange={(id) => {
              setChosenEnvironmentId(id as EnvironmentId);
              setChosenProjectId(null);
            }}
          >
            <div className="grid w-56 grid-cols-1">
              <SelectTrigger size="sm" aria-label="Template environment">
                <SelectValue>
                  <span className="flex items-center gap-2">
                    <EnvironmentMachineIcon
                      kind={resolveEnvironmentMachineKind(
                        selectedEnvironment?.serverConfig ?? null,
                      )}
                      className="size-4"
                    />
                    {selectedEnvironment?.label}
                  </span>
                </SelectValue>
              </SelectTrigger>
            </div>
            <SelectPopup>
              {readable.map((entry) => (
                <SelectItem
                  key={entry.environmentId}
                  value={entry.environmentId}
                  label={entry.label}
                >
                  {entry.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        <Select
          value={projectId ?? ""}
          onValueChange={(id) => setChosenProjectId((id as ProjectId | null) ?? null)}
        >
          <div className="grid w-56 grid-cols-1">
            <SelectTrigger size="sm" aria-label="Template project">
              <SelectValue placeholder="Select a project">{selectedProject?.title}</SelectValue>
            </SelectTrigger>
          </div>
          <SelectPopup>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id} label={project.title}>
                <span className="block truncate">{project.title}</span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <SettingsSection title="Templates" hideTitle>
        {projectId === null ? (
          <SettingsRow title="No project" description="Add a project to keep templates in it." />
        ) : templatesQuery.error ? (
          <SettingsRow title="Could not load templates" description={templatesQuery.error} />
        ) : !templates ? (
          <SettingsRow title="Loading templates…" role="status" />
        ) : templates.length === 0 ? (
          <SettingsRow
            title="No templates"
            description="Templates are saved in the project's .t3/triggers folder."
          />
        ) : (
          templates.map((template) => (
            <SettingsRow
              key={template.name}
              title={template.title}
              description={`${template.name} · ${TRIGGER_SOURCE_LABELS[template.source]} · ${
                template.filters.length
              } filter${template.filters.length === 1 ? "" : "s"}`}
              control={
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canCreateTask(environmentId)}
                    aria-label={`Use ${template.title}`}
                    onClick={() =>
                      template.placeholders.length === 0
                        ? applyTemplate(template, {})
                        : setUsing(template)
                    }
                  >
                    <PlayIcon />
                    Use
                  </Button>
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={!canManage}
                          aria-label={`Actions for ${template.title}`}
                        />
                      }
                    >
                      <MoreHorizontalIcon className="size-4" />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuItem onClick={() => setEditing({ template })}>
                        <PencilIcon />
                        Edit
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem onClick={() => void deleteTemplate(template)}>
                        <Trash2Icon />
                        Delete
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </div>
              }
            />
          ))
        )}
      </SettingsSection>
      {editing && projectId !== null ? (
        <TriggerTemplateEditorDialog
          environmentId={environmentId}
          projectId={projectId}
          template={editing.template}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {using ? (
        <UseTemplateDialog
          template={using}
          onUse={(values) => applyTemplate(using, values)}
          onClose={() => setUsing(null)}
        />
      ) : null}
    </SettingsSection>
  );
}

function UseTemplateDialog({
  template,
  onUse,
  onClose,
}: {
  readonly template: TriggerTemplate;
  readonly onUse: (values: Readonly<Record<string, string>>) => void;
  readonly onClose: () => void;
}) {
  const [values, setValues] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(
      template.placeholders.map((placeholder) => [placeholder.name, placeholder.default ?? ""]),
    ),
  );
  const missing = fillTriggerTemplate(template, values).missing;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Use {template.title}</DialogTitle>
          <DialogDescription>Fill in the template's values for the new task.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            {template.placeholders.map((placeholder) => (
              <Field
                key={placeholder.name}
                label={placeholder.name}
                {...(placeholder.default === undefined ? { hint: "required" } : {})}
                htmlFor={`trigger-template-value-${placeholder.name}`}
              >
                <Input
                  id={`trigger-template-value-${placeholder.name}`}
                  value={values[placeholder.name] ?? ""}
                  placeholder={placeholder.default}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [placeholder.name]: event.target.value }))
                  }
                />
                {placeholder.description ? (
                  <p className="text-xs text-muted-foreground">{placeholder.description}</p>
                ) : null}
              </Field>
            ))}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
          <Button size="sm" disabled={missing.length > 0} onClick={() => onUse(values)}>
            Create task
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function TriggerTemplateEditorDialog({
  environmentId,
  projectId,
  template,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly template: TriggerTemplate | null;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState<TemplateDraft>(() => templateToDraft(template));
  const [saving, setSaving] = useState(false);
  const canManage = useAtomValue(
    serverEnvironment.saveTriggerTemplate.permissionAtom(environmentId),
  );
  const save = useAtomCommand(serverEnvironment.saveTriggerTemplate, {
    label: "trigger template save",
  });
  const submit = async () => {
    if (saving) return;
    const built = templateFromDraft(draft);
    if ("error" in built) {
      reportFailure("Template is incomplete", built.error);
      return;
    }
    setSaving(true);
    const result = await save({ environmentId, input: { projectId, template: built.template } });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        reportFailure("Could not save template", squashAtomCommandFailure(result));
      return;
    }
    onClose();
  };
  const updatePlaceholder = (id: string, patch: Partial<TemplateDraft["placeholders"][number]>) =>
    setDraft((current) => ({
      ...current,
      placeholders: current.placeholders.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{draft.savedName === null ? "New template" : "Edit template"}</DialogTitle>
          <DialogDescription>
            {"A trigger with {{placeholder}} values that someone fills in when they use it."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={saving} className="min-w-0 space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" hint="file name" htmlFor="trigger-template-name">
                <Input
                  id="trigger-template-name"
                  placeholder="issue-in-progress"
                  disabled={draft.savedName !== null}
                  value={draft.name}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, name: event.target.value }))
                  }
                />
              </Field>
              <Field label="Title" htmlFor="trigger-template-title">
                <Input
                  id="trigger-template-title"
                  placeholder="Issue enters In Progress"
                  value={draft.title}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, title: event.target.value }))
                  }
                />
              </Field>
            </div>
            <Field label="Source" htmlFor="trigger-template-source">
              <Select
                value={draft.source}
                onValueChange={(value) => {
                  const source = SOURCES.find((entry) => entry === value);
                  if (source === undefined) return;
                  setDraft((current) =>
                    current.source === source
                      ? current
                      : { ...current, source, webhookFilters: [], triggerFilters: [] },
                  );
                }}
              >
                <SelectTrigger size="sm" id="trigger-template-source">
                  <SelectValue>{TRIGGER_SOURCE_LABELS[draft.source]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {SOURCES.map((source) => (
                    <SelectItem key={source} value={source}>
                      {TRIGGER_SOURCE_LABELS[source]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            {draft.source === "webhook" ? (
              <WebhookFiltersField
                filters={draft.webhookFilters}
                onChange={(webhookFilters) =>
                  setDraft((current) => ({ ...current, webhookFilters }))
                }
              />
            ) : isTriggerFilterSource(draft.source) ? (
              <TriggerFiltersField
                source={draft.source}
                filters={draft.triggerFilters}
                onChange={(triggerFilters) =>
                  setDraft((current) => ({ ...current, triggerFilters }))
                }
              />
            ) : null}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 space-y-1">
                  <Label>Placeholders</Label>
                  <p className="text-sm text-muted-foreground">
                    {
                      "Use {{name}} in filter values and the prompt. A placeholder without a default must be filled in."
                    }
                  </p>
                </div>
                <Button
                  className="shrink-0"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      placeholders: [...current.placeholders, emptyPlaceholderDraft()],
                    }))
                  }
                >
                  <PlusIcon />
                  Add placeholder
                </Button>
              </div>
              {draft.placeholders.map((row, index) => (
                <div key={row.id} className="space-y-2 pt-1">
                  <div className="flex items-center gap-2">
                    <div className="grid min-w-0 flex-1 grid-cols-1">
                      <Input
                        aria-label={`Placeholder ${index + 1} name`}
                        placeholder="status"
                        value={row.name}
                        onChange={(event) =>
                          updatePlaceholder(row.id, { name: event.target.value })
                        }
                      />
                    </div>
                    <div className="grid min-w-0 flex-1 grid-cols-1">
                      <Input
                        aria-label={`Placeholder ${index + 1} default`}
                        placeholder="Default, optional"
                        value={row.default}
                        onChange={(event) =>
                          updatePlaceholder(row.id, { default: event.target.value })
                        }
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove placeholder ${index + 1}`}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          placeholders: current.placeholders.filter((entry) => entry.id !== row.id),
                        }))
                      }
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                  <Input
                    aria-label={`Placeholder ${index + 1} description`}
                    placeholder="Description, optional"
                    value={row.description}
                    onChange={(event) =>
                      updatePlaceholder(row.id, { description: event.target.value })
                    }
                  />
                </div>
              ))}
            </div>
            <Field label="Prompt" htmlFor="trigger-template-prompt">
              <Textarea
                id="trigger-template-prompt"
                className="max-h-64 overflow-y-auto"
                value={draft.prompt}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, prompt: event.target.value }))
                }
              />
              {isTriggerFilterSource(draft.source) ? (
                <TriggerPromptHint source={draft.source} />
              ) : null}
            </Field>
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={!canManage || saving} onClick={() => void submit()}>
            {draft.savedName === null ? "Create template" : "Save template"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
