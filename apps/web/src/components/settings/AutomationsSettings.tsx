import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ProviderInstanceId,
  ScheduledAutomationId,
  isScheduledAutomationProviderEligible,
  type EnvironmentId,
  type ModelSelection,
  type ProviderOptionDescriptor,
  type ScheduledAutomation,
  type ScheduledAutomationCommand,
  type ScheduledAutomationHealth,
  type ScheduledAutomationDefinitionDraft,
  type ScheduledAutomationValidationField,
  type ScheduledAutomationView,
  type ServerProvider,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  BotIcon,
  CalendarClockIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { usePrimaryEnvironment } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { usePaginatedBranches } from "../../state/queries";
import { primaryServerProvidersAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  INITIAL_SCHEDULED_AUTOMATION_HEALTH,
  scheduledAutomationEnvironment,
  type ScheduledAutomationState,
} from "../../state/scheduledAutomations";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import {
  EMPTY_AUTOMATION_DEFINITION,
  AUTOMATION_ID_ERROR,
  ABANDON_AUTOMATION_DISCLOSURE,
  CURRENT_WORKSPACE_DISCLOSURE,
  DELETE_AUTOMATION_DISCLOSURE,
  DISABLE_AUTOMATION_DISCLOSURE,
  NEW_WORKTREE_DISCLOSURE,
  automationDraftFromRow,
  applyAutomationConflictRows,
  buildAutomationRevisionCommand,
  buildAutomationSaveCommand,
  canAbandonAutomation,
  canDeleteAutomation,
  canRetryAutomation,
  canSubmitAutomationDraft,
  changeAutomationProject,
  defaultLiveModelSelection,
  isValidAutomationId,
  liveModelSelection,
  normalizeProviderOptions,
  previewAutomationSchedule,
  reconcileAutomationCommandFailure,
  type AutomationProjectOption,
} from "./AutomationsSettings.logic";

export interface AutomationsSettingsProps {
  readonly environmentId: EnvironmentId;
  readonly views: ReadonlyArray<ScheduledAutomationView>;
  readonly health?: ScheduledAutomationHealth;
  readonly projects: ReadonlyArray<AutomationProjectOption>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly isPending?: boolean;
  readonly loadError?: string | null;
  readonly onCommand: (command: ScheduledAutomationCommand) => Promise<ScheduledAutomation | null>;
}

export function AutomationHealthNotice(props: {
  readonly health?: ScheduledAutomationHealth | undefined;
}) {
  if (props.health?.status !== "degraded") return null;
  return (
    <div
      role="status"
      className="mx-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm sm:mx-4"
    >
      <p className="font-medium">Automation scheduling needs attention</p>
      <p className="mt-1 text-muted-foreground">
        {props.health.schedulerStatus === "failed"
          ? "The scheduler stopped; unrelated conversations remain available. "
          : ""}
        {props.health.malformedDefinitionCount > 0
          ? `${props.health.malformedDefinitionCount} stored definition${props.health.malformedDefinitionCount === 1 ? " is malformed and was" : "s are malformed and were"} not scheduled.`
          : ""}
      </p>
    </div>
  );
}

const EMPTY_AUTOMATIONS_ATOM = Atom.make(
  AsyncResult.initial<ScheduledAutomationState, never>(false),
).pipe(Atom.withLabel("web:scheduled-automations:empty"));

function modelKey(selection: Pick<ModelSelection, "instanceId" | "model">): string {
  return JSON.stringify([selection.instanceId, selection.model]);
}

function parseModelKey(value: string): Pick<ModelSelection, "instanceId" | "model"> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      !parsed.every((item) => typeof item === "string")
    ) {
      return null;
    }
    return { instanceId: ProviderInstanceId.make(parsed[0]!), model: parsed[1]! };
  } catch {
    return null;
  }
}

function modelOptions(providers: ReadonlyArray<ServerProvider>) {
  return providers.flatMap((provider) =>
    isScheduledAutomationProviderEligible(provider)
      ? provider.models.map((model) => ({
          provider,
          model,
          key: modelKey({ instanceId: provider.instanceId, model: model.slug }),
          label: `${provider.displayName ?? provider.instanceId} · ${model.name}`,
        }))
      : [],
  );
}

function selectedModelDescriptors(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): ReadonlyArray<ProviderOptionDescriptor> {
  return (
    providers
      .find((provider) => provider.instanceId === selection.instanceId)
      ?.models.find((model) => model.slug === selection.model)?.capabilities?.optionDescriptors ??
    []
  );
}

export function AutomationFieldError({
  errors,
  field,
}: {
  errors: Partial<Record<ScheduledAutomationValidationField, string>>;
  field: ScheduledAutomationValidationField;
}) {
  return errors[field] ? (
    <p className="text-xs text-destructive-foreground">{errors[field]}</p>
  ) : null;
}

export function AutomationEditor(props: {
  readonly open: boolean;
  readonly existing: ScheduledAutomation | null;
  readonly projects: ReadonlyArray<AutomationProjectOption>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCommand: AutomationsSettingsProps["onCommand"];
  readonly onConflict: (current: ScheduledAutomation) => void;
}) {
  const initialProject = props.projects[0] ?? null;
  const initialModel = defaultLiveModelSelection(props.providers, initialProject);
  const [automationId, setAutomationId] = useState(props.existing?.id ?? "");
  const [draft, setDraft] = useState<ScheduledAutomationDefinitionDraft>(() =>
    props.existing
      ? automationDraftFromRow(props.existing, props.providers)
      : {
          ...EMPTY_AUTOMATION_DEFINITION,
          ...(initialProject ? { projectId: initialProject.id } : {}),
          ...(initialModel ? { modelSelection: initialModel } : {}),
        },
  );
  const [errors, setErrors] = useState<Partial<Record<ScheduledAutomationValidationField, string>>>(
    {},
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ScheduledAutomation | null>(null);
  const [saving, setSaving] = useState(false);

  const selectedProject = props.projects.find((project) => project.id === draft.projectId) ?? null;
  const [branchQuery, setBranchQuery] = useState("");
  const deferredBranchQuery = useDeferredValue(branchQuery);
  const branchTargetActive = props.open && draft.worktreePolicy.kind === "new-worktree";
  const branches = usePaginatedBranches({
    environmentId:
      branchTargetActive && selectedProject ? (selectedProject.environmentId ?? null) : null,
    cwd: branchTargetActive ? (selectedProject?.workspaceRoot ?? null) : null,
    query: deferredBranchQuery,
  });
  const branchTargetKey = branchTargetActive
    ? `${selectedProject?.id ?? "missing"}:${selectedProject?.workspaceRoot ?? "missing"}`
    : null;
  const lastRefreshedBranchTarget = useRef<string | null>(null);
  useEffect(() => {
    if (branchTargetKey === null) {
      lastRefreshedBranchTarget.current = null;
      return;
    }
    if (lastRefreshedBranchTarget.current === branchTargetKey) return;
    lastRefreshedBranchTarget.current = branchTargetKey;
    branches.refresh();
  }, [branchTargetKey, branches.refresh]);
  const selectableModels = useMemo(() => modelOptions(props.providers), [props.providers]);
  const descriptors = selectedModelDescriptors(props.providers, draft.modelSelection);
  const normalizedLiveModel = useMemo(
    () => liveModelSelection(props.providers, draft.modelSelection),
    [draft.modelSelection, props.providers],
  );
  const modelIsLive = normalizedLiveModel !== null;
  const normalizedLiveModelKey = JSON.stringify(normalizedLiveModel);
  useEffect(() => {
    if (!normalizedLiveModel) return;
    setDraft((current) =>
      JSON.stringify(current.modelSelection) === normalizedLiveModelKey
        ? current
        : { ...current, modelSelection: normalizedLiveModel },
    );
  }, [normalizedLiveModel, normalizedLiveModelKey]);
  const existingForSave = conflict ?? props.existing;
  const canSubmit =
    !saving &&
    canSubmitAutomationDraft({
      automationId,
      draft,
      existing: existingForSave,
      projectAvailable: selectedProject !== null,
      modelLive: modelIsLive,
      worktreeAvailable: draft.worktreePolicy.kind === "current" || branches.data?.isRepo === true,
    });
  const idError = automationId.length > 0 && !isValidAutomationId(automationId);
  const schedulePreview = useMemo(
    () => previewAutomationSchedule(draft.schedule, new Date().toISOString()),
    [draft.schedule],
  );

  const updateOption = (descriptor: ProviderOptionDescriptor, value: string | boolean) => {
    const current = normalizeProviderOptions(descriptors, draft.modelSelection.options) ?? [];
    setDraft((valueDraft) => ({
      ...valueDraft,
      modelSelection: {
        ...valueDraft.modelSelection,
        options: current.map((selection) =>
          selection.id === descriptor.id ? { ...selection, value } : selection,
        ),
      },
    }));
  };

  const submit = async () => {
    if (!isValidAutomationId(automationId)) {
      setFormError(AUTOMATION_ID_ERROR);
      return;
    }
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      await props.onCommand(
        buildAutomationSaveCommand({
          automationId: ScheduledAutomationId.make(automationId.trim()),
          definition: draft,
          existing: existingForSave,
          now: new Date().toISOString(),
        }),
      );
      props.onOpenChange(false);
    } catch (cause) {
      const failure = reconcileAutomationCommandFailure(cause);
      if (failure.kind === "validation") {
        setErrors(failure.errors);
      } else if (failure.kind === "conflict") {
        props.onConflict(failure.current);
        setConflict(failure.current);
        setAutomationId(failure.current.id);
        setDraft(automationDraftFromRow(failure.current, props.providers));
      } else {
        setFormError(failure.message);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existingForSave ? "Edit automation" : "Create automation"}</DialogTitle>
          <DialogDescription>
            Scheduled runs are disabled until you explicitly enable the saved definition.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          {conflict ? (
            <div
              role="alert"
              className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
            >
              This automation changed on another device. Your draft now shows server revision{" "}
              {conflict.revision}; review it before saving again.
            </div>
          ) : null}
          {formError ? (
            <div role="alert" className="text-sm text-destructive-foreground">
              {formError}
            </div>
          ) : null}
          <label className="grid gap-1.5 text-sm font-medium">
            Automation ID
            <Input
              nativeInput
              value={automationId}
              disabled={existingForSave !== null}
              aria-invalid={idError}
              onChange={(event) => setAutomationId(event.currentTarget.value)}
              placeholder="weekday-review"
            />
            {idError ? (
              <p className="text-xs text-destructive-foreground">{AUTOMATION_ID_ERROR}</p>
            ) : null}
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Name
            <Input
              nativeInput
              value={draft.name}
              aria-invalid={Boolean(errors.name)}
              onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
            />
            <AutomationFieldError errors={errors} field="name" />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Prompt
            <Textarea
              value={draft.prompt}
              aria-invalid={Boolean(errors.prompt)}
              onChange={(event) => setDraft({ ...draft, prompt: event.currentTarget.value })}
            />
            <AutomationFieldError errors={errors} field="prompt" />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Project
            <select
              className="h-9 rounded-lg border border-input bg-background px-3"
              value={draft.projectId}
              onChange={(event) => {
                const project = props.projects.find(
                  (candidate) => candidate.id === event.currentTarget.value,
                );
                if (project) setDraft(changeAutomationProject(draft, project, props.providers));
              }}
            >
              {selectedProject === null && draft.projectId ? (
                <option value={draft.projectId}>Unavailable project · {draft.projectId}</option>
              ) : null}
              {props.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
            <AutomationFieldError errors={errors} field="projectId" />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Provider and model
            <select
              className="h-9 rounded-lg border border-input bg-background px-3"
              value={modelKey(draft.modelSelection)}
              aria-invalid={Boolean(errors.modelSelection)}
              onChange={(event) => {
                const parsed = parseModelKey(event.currentTarget.value);
                if (!parsed) return;
                const provider = props.providers.find(
                  (candidate) => candidate.instanceId === parsed.instanceId,
                );
                const model = provider?.models.find((candidate) => candidate.slug === parsed.model);
                const options = normalizeProviderOptions(
                  model?.capabilities?.optionDescriptors ?? [],
                  undefined,
                );
                setDraft({
                  ...draft,
                  modelSelection: { ...parsed, ...(options ? { options } : {}) },
                });
              }}
            >
              {!modelIsLive && draft.modelSelection.model ? (
                <option value={modelKey(draft.modelSelection)}>
                  Unavailable model · {draft.modelSelection.instanceId} ·{" "}
                  {draft.modelSelection.model}
                </option>
              ) : (
                <option value="" disabled>
                  Select a live model
                </option>
              )}
              {selectableModels.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
            <AutomationFieldError errors={errors} field="modelSelection" />
          </label>
          {descriptors.map((descriptor) => {
            const current = normalizeProviderOptions(
              descriptors,
              draft.modelSelection.options,
            )?.find((selection) => selection.id === descriptor.id)?.value;
            return descriptor.type === "boolean" ? (
              <label key={descriptor.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={current === true}
                  onCheckedChange={(checked) => updateOption(descriptor, checked === true)}
                />
                {descriptor.label}
              </label>
            ) : (
              <label key={descriptor.id} className="grid gap-1.5 text-sm font-medium">
                {descriptor.label}
                <select
                  className="h-9 rounded-lg border border-input bg-background px-3"
                  value={typeof current === "string" ? current : ""}
                  onChange={(event) => updateOption(descriptor, event.currentTarget.value)}
                >
                  {descriptor.options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              Runtime mode
              <select
                className="h-9 rounded-lg border border-input bg-background px-3"
                value={draft.runtimeMode}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    runtimeMode: event.currentTarget
                      .value as ScheduledAutomationDefinitionDraft["runtimeMode"],
                  })
                }
              >
                <option value="approval-required">Approval required</option>
                <option value="auto-accept-edits">Auto accept edits</option>
                <option value="auto">Auto</option>
                <option value="full-access">Full access</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Interaction mode
              <select
                className="h-9 rounded-lg border border-input bg-background px-3"
                value={draft.interactionMode}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    interactionMode: event.currentTarget
                      .value as ScheduledAutomationDefinitionDraft["interactionMode"],
                  })
                }
              >
                <option value="default">Build</option>
                <option value="plan">Plan</option>
              </select>
            </label>
          </div>
          <fieldset className="grid gap-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">Workspace</legend>
            <label className="flex gap-2 text-sm">
              <input
                type="radio"
                name="worktree-policy"
                checked={draft.worktreePolicy.kind === "current"}
                onChange={() => setDraft({ ...draft, worktreePolicy: { kind: "current" } })}
              />
              <span>
                <strong>Current workspace</strong>
                <span className="block text-xs text-muted-foreground">
                  {CURRENT_WORKSPACE_DISCLOSURE}
                </span>
              </span>
            </label>
            <label className="flex gap-2 text-sm">
              <input
                type="radio"
                name="worktree-policy"
                checked={draft.worktreePolicy.kind === "new-worktree"}
                onChange={() =>
                  setDraft({
                    ...draft,
                    worktreePolicy: { kind: "new-worktree", baseBranch: "", startFromOrigin: true },
                  })
                }
              />
              <span>
                <strong>New worktree</strong>
                <span className="block text-xs text-muted-foreground">
                  {NEW_WORKTREE_DISCLOSURE}
                </span>
              </span>
            </label>
            {draft.worktreePolicy.kind === "new-worktree" ? (
              <>
                <AutomationFieldError errors={errors} field="worktreePolicy" />
                <label className="grid gap-1.5 text-sm font-medium">
                  Search branches
                  <span className="relative">
                    <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      nativeInput
                      className="pl-9"
                      value={branchQuery}
                      onChange={(event) => setBranchQuery(event.currentTarget.value)}
                      placeholder="Filter branches"
                    />
                  </span>
                </label>
                {branches.error ? (
                  <div
                    role="alert"
                    className="flex items-center justify-between gap-3 text-xs text-destructive-foreground"
                  >
                    <span>{branches.error}</span>
                    <Button type="button" size="xs" variant="outline" onClick={branches.refresh}>
                      <RefreshCwIcon /> Retry
                    </Button>
                  </div>
                ) : null}
                {branches.data && !branches.data.isRepo ? (
                  <p role="alert" className="text-xs text-destructive-foreground">
                    New worktrees require a Git project.
                  </p>
                ) : null}
                <label className="grid gap-1.5 text-sm font-medium">
                  Base branch
                  <select
                    className="h-9 rounded-lg border border-input bg-background px-3"
                    value={draft.worktreePolicy.baseBranch}
                    aria-invalid={Boolean(errors["worktreePolicy.baseBranch"])}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        worktreePolicy: {
                          ...(draft.worktreePolicy as Extract<
                            typeof draft.worktreePolicy,
                            { kind: "new-worktree" }
                          >),
                          baseBranch: event.currentTarget.value,
                        },
                      })
                    }
                  >
                    <option value="" disabled>
                      {branches.isPending ? "Loading branches…" : "Select a branch"}
                    </option>
                    {branches.refs.map((ref) => (
                      <option key={ref.name} value={ref.name}>
                        {ref.name}
                      </option>
                    ))}
                  </select>
                  <AutomationFieldError errors={errors} field="worktreePolicy.baseBranch" />
                </label>
                {branches.data?.nextCursor != null ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={branches.isFetchingNextPage}
                    onClick={branches.loadNext}
                  >
                    {branches.isFetchingNextPage ? "Loading…" : "Load more branches"}
                  </Button>
                ) : null}
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.worktreePolicy.startFromOrigin}
                    onCheckedChange={(checked) =>
                      setDraft({
                        ...draft,
                        worktreePolicy: {
                          ...(draft.worktreePolicy as Extract<
                            typeof draft.worktreePolicy,
                            { kind: "new-worktree" }
                          >),
                          startFromOrigin: checked === true,
                        },
                      })
                    }
                  />
                  Start from origin
                </label>
              </>
            ) : null}
          </fieldset>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              Cron schedule
              <Input
                nativeInput
                value={draft.schedule.cron}
                aria-invalid={Boolean(errors["schedule.cron"])}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    schedule: { ...draft.schedule, cron: event.currentTarget.value },
                  })
                }
                placeholder="0 9 * * 1-5"
              />
              <AutomationFieldError errors={errors} field="schedule.cron" />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              IANA timezone
              <Input
                nativeInput
                value={draft.schedule.timeZone}
                aria-invalid={Boolean(errors["schedule.timeZone"])}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    schedule: { ...draft.schedule, timeZone: event.currentTarget.value },
                  })
                }
                placeholder="America/New_York"
              />
              <AutomationFieldError errors={errors} field="schedule.timeZone" />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            {schedulePreview.next
              ? `Advisory preview: next run ${new Date(schedulePreview.next).toLocaleString()}. `
              : `Advisory preview unavailable: ${schedulePreview.error ?? "invalid schedule"}. `}
            The server validates cron, timezone, and schema on every save. Live project, branch,
            provider, model, and option availability is checked when enabling and when saving an
            already-enabled automation.
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            {saving ? "Saving…" : "Save automation"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function outcomeLabel(view: ScheduledAutomationView): string {
  if (!view.automation.lastOutcome) return "Never run";
  const count = view.automation.lastOutcome.coalescedCount;
  return `${view.automation.lastOutcome.kind.replaceAll("-", " ")}${count > 0 ? ` · ${count} coalesced` : ""}`;
}

function statusLabel(view: ScheduledAutomationView): string {
  return view.status.replaceAll("-", " ");
}

export function AutomationRow(props: {
  readonly environmentId: EnvironmentId;
  readonly view: ScheduledAutomationView;
  readonly project: AutomationProjectOption | undefined;
  readonly provider: ServerProvider | undefined;
  readonly pending: boolean;
  readonly onEdit: () => void;
  readonly onAction: (
    action: "enable" | "disable" | "retry" | "abandon" | "delete",
  ) => Promise<void>;
}) {
  const { automation } = props.view;
  const lastExecutionError =
    props.view.status === "failed" ? props.view.lastThread?.session?.lastError : null;
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [abandonOpen, setAbandonOpen] = useState(false);
  const effort = automation.modelSelection.options?.find((option) =>
    option.id.toLocaleLowerCase().includes("effort"),
  );
  return (
    <article className="rounded-xl border border-border/70 bg-card/30 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-medium">{automation.name}</h3>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${automation.enabled ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-muted text-muted-foreground"}`}
            >
              {automation.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {automation.schedule.cron} · {automation.schedule.timeZone}
          </p>
        </div>
        <div className="flex gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Edit ${automation.name}`}
            disabled={props.pending}
            onClick={props.onEdit}
          >
            <PencilIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Delete ${automation.name}`}
            disabled={props.pending || !canDeleteAutomation(automation)}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2Icon />
          </Button>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm lg:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Next occurrence</dt>
          <dd>
            {props.view.nextScheduledFor
              ? new Date(props.view.nextScheduledFor).toLocaleString()
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Project</dt>
          <dd>{props.project?.title ?? "Unavailable project"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Model / effort</dt>
          <dd>
            {props.provider?.displayName ?? automation.modelSelection.instanceId} ·{" "}
            {automation.modelSelection.model}
            {effort ? ` · ${String(effort.value)}` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Workspace</dt>
          <dd>
            {automation.worktreePolicy.kind === "current"
              ? "Current (shared)"
              : `New worktree · ${automation.worktreePolicy.baseBranch}`}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Current status</dt>
          <dd className="capitalize">{statusLabel(props.view)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Last outcome</dt>
          <dd className="capitalize">{outcomeLabel(props.view)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Cursor</dt>
          <dd>
            {automation.lastScheduledFor
              ? new Date(automation.lastScheduledFor).toLocaleString()
              : "Never claimed"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Last thread</dt>
          <dd>
            {automation.lastThreadId ? (
              <Link
                className="text-primary underline-offset-4 hover:underline"
                to="/$environmentId/$threadId"
                params={buildThreadRouteParams(
                  scopeThreadRef(props.environmentId, automation.lastThreadId),
                )}
              >
                Open thread
              </Link>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>
      {automation.lastOutcome?.kind === "failed" ? (
        <div className="mt-3 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm">
          <p className="font-medium">{automation.lastOutcome.code}</p>
          <p className="mt-1 text-muted-foreground">{automation.lastOutcome.detail}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {automation.lastOutcome.retryable
              ? "Retryable after inspection."
              : "Not retryable; disable and abandon this occurrence before correcting resources."}
          </p>
        </div>
      ) : null}
      {lastExecutionError ? (
        <div className="mt-3 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm">
          <p className="font-medium">Last execution error</p>
          <p className="mt-1 text-muted-foreground">{lastExecutionError}</p>
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="xs"
          variant={automation.enabled ? "outline" : "default"}
          disabled={props.pending}
          onClick={() => void props.onAction(automation.enabled ? "disable" : "enable")}
        >
          {automation.enabled ? "Disable" : "Enable"}
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={props.pending || !canRetryAutomation(automation)}
          onClick={() => void props.onAction("retry")}
        >
          Retry last
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={props.pending || !canAbandonAutomation(automation)}
          onClick={() => setAbandonOpen(true)}
        >
          Abandon last occurrence
        </Button>
        {automation.enabled && automation.lastThreadId ? (
          <span className="self-center text-xs text-muted-foreground">
            {DISABLE_AUTOMATION_DISCLOSURE}
          </span>
        ) : null}
      </div>
      <AlertDialog open={abandonOpen} onOpenChange={setAbandonOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Abandon the last occurrence?</AlertDialogTitle>
            <AlertDialogDescription>{ABANDON_AUTOMATION_DISCLOSURE}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={props.pending}
              onClick={() => {
                setAbandonOpen(false);
                void props.onAction("abandon");
              }}
            >
              Abandon occurrence
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{automation.name}”?</AlertDialogTitle>
            <AlertDialogDescription>{DELETE_AUTOMATION_DISCLOSURE}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setDeleteOpen(false);
                void props.onAction("delete");
              }}
            >
              Delete automation
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </article>
  );
}

export function AutomationsSettings(props: AutomationsSettingsProps) {
  const [editor, setEditor] = useState<{
    open: boolean;
    existing: ScheduledAutomation | null;
    session: number;
  }>({ open: false, existing: null, session: 0 });
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingActionIds, setPendingActionIds] = useState<ReadonlySet<ScheduledAutomation["id"]>>(
    new Set(),
  );
  const pendingActionIdsRef = useRef(new Set<ScheduledAutomation["id"]>());
  const [conflictRows, setConflictRows] = useState<
    ReadonlyMap<ScheduledAutomation["id"], ScheduledAutomation>
  >(new Map());
  useEffect(() => {
    setConflictRows((current) => {
      const next = new Map(current);
      for (const view of props.views) {
        const conflict = next.get(view.automation.id);
        if (conflict && view.automation.revision >= conflict.revision) {
          next.delete(view.automation.id);
        }
      }
      return next.size === current.size ? current : next;
    });
  }, [props.views]);
  const visibleViews = applyAutomationConflictRows(props.views, conflictRows);
  const runAction = async (
    automation: ScheduledAutomation,
    action: "enable" | "disable" | "retry" | "abandon" | "delete",
  ) => {
    if (pendingActionIdsRef.current.has(automation.id)) return;
    pendingActionIdsRef.current.add(automation.id);
    setPendingActionIds(new Set(pendingActionIdsRef.current));
    setActionError(null);
    try {
      await props.onCommand(
        buildAutomationRevisionCommand(automation, action, new Date().toISOString()),
      );
    } catch (cause) {
      const failure = reconcileAutomationCommandFailure(cause);
      if (failure.kind === "conflict") {
        setConflictRows((current) => new Map(current).set(failure.current.id, failure.current));
      }
      setActionError(
        failure.kind === "validation"
          ? (Object.values(failure.errors)[0] ?? "The automation could not be changed.")
          : failure.message,
      );
    } finally {
      pendingActionIdsRef.current.delete(automation.id);
      setPendingActionIds(new Set(pendingActionIdsRef.current));
    }
  };
  return (
    <SettingsPageContainer>
      <SettingsSection
        id="automations"
        title="Automations"
        icon={<CalendarClockIcon className="size-5" />}
        headerAction={
          <Button
            size="sm"
            onClick={() =>
              setEditor((current) => ({
                open: true,
                existing: null,
                session: current.session + 1,
              }))
            }
          >
            <PlusIcon />
            New automation
          </Button>
        }
      >
        <div className="rounded-xl px-3 pb-3 text-sm text-muted-foreground sm:px-4">
          Create durable scheduled prompts for this environment. Definitions remain disabled until
          enabled, and unattended setup scripts are always skipped in v1.
        </div>
        {actionError ? (
          <div
            role="alert"
            className="mx-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-foreground sm:mx-4"
          >
            {actionError}
          </div>
        ) : null}
        {props.loadError ? (
          <div role="alert" className="mx-3 text-sm text-destructive-foreground sm:mx-4">
            {props.loadError}
          </div>
        ) : null}
        <AutomationHealthNotice health={props.health} />
        <div className="grid gap-3 px-3 sm:px-4">
          {visibleViews.map((view) => (
            <AutomationRow
              key={view.automation.id}
              environmentId={props.environmentId}
              view={view}
              project={props.projects.find((project) => project.id === view.automation.projectId)}
              provider={props.providers.find(
                (provider) => provider.instanceId === view.automation.modelSelection.instanceId,
              )}
              pending={pendingActionIds.has(view.automation.id)}
              onEdit={() =>
                setEditor((current) => ({
                  open: true,
                  existing: view.automation,
                  session: current.session + 1,
                }))
              }
              onAction={(action) => runAction(view.automation, action)}
            />
          ))}
          {!props.isPending && !props.loadError && visibleViews.length === 0 ? (
            <div className="rounded-xl border border-dashed p-8 text-center">
              <BotIcon className="mx-auto mb-2 size-5 text-muted-foreground" />
              <p className="font-medium">No automations yet</p>
              <p className="text-sm text-muted-foreground">
                Create one to schedule a prompt. It will start disabled.
              </p>
            </div>
          ) : null}
          {props.isPending && visibleViews.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading automations…</p>
          ) : null}
        </div>
      </SettingsSection>
      <AutomationEditor
        key={`${editor.existing?.id ?? "new"}:${editor.session}`}
        open={editor.open}
        existing={editor.existing}
        projects={props.projects}
        providers={props.providers}
        onOpenChange={(open) => setEditor((current) => ({ ...current, open }))}
        onCommand={props.onCommand}
        onConflict={(current) => setConflictRows((rows) => new Map(rows).set(current.id, current))}
      />
    </SettingsPageContainer>
  );
}

export function AutomationsSettingsPanel() {
  const environment = usePrimaryEnvironment();
  const environmentId = environment?.environmentId ?? null;
  const dispatchAutomation = useAtomCommand(scheduledAutomationEnvironment.dispatch);
  const allProjects = useProjects();
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const providers = useAtomValue(primaryServerProvidersAtom);
  const result = useAtomValue(
    environmentId
      ? scheduledAutomationEnvironment.state({ environmentId, input: {} })
      : EMPTY_AUTOMATIONS_ATOM,
  );
  const state =
    result._tag === "Success"
      ? result.value
      : { views: [], health: INITIAL_SCHEDULED_AUTOMATION_HEALTH };
  const loadError =
    result._tag === "Failure" ? "Could not load automations for this environment." : null;
  if (!environmentId)
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          Connect an environment to manage automations.
        </p>
      </SettingsPageContainer>
    );
  return (
    <AutomationsSettings
      environmentId={environmentId}
      views={state.views}
      health={state.health}
      projects={projects}
      providers={providers}
      isPending={result.waiting}
      loadError={loadError}
      onCommand={async (command) => {
        const commandResult = await dispatchAutomation({
          environmentId,
          input: command,
        });
        if (commandResult._tag === "Failure") throw squashAtomCommandFailure(commandResult);
        return commandResult.value.automation;
      }}
    />
  );
}
