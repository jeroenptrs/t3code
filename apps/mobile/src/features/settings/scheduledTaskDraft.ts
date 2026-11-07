import { isWebhookDedupeTemplate, scheduledTaskThreadMode } from "@t3tools/contracts";
import type {
  FactoryId,
  ModelSelection,
  TriggerFilterSourceKind,
  ServerConfig,
  ProjectId,
  RuntimeMode,
  ScheduledTask,
  ScheduledTaskThreadMode,
  ScheduledTaskUpsertInput,
  ScheduledTaskUpsertSchedule,
  ScheduledTaskWebhookSignature,
  ThreadId,
} from "@t3tools/contracts";

import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SERVER_SETTINGS,
  MIN_POLL_INTERVAL_MS,
} from "@t3tools/contracts";
import {
  DEFAULT_WEBHOOK_PROMPT,
  parseMaxDeliveryAge,
  parseWebhookFilterDrafts,
  webhookFilterDrafts,
  webhookFilterDraftsChanged,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
import {
  DEFAULT_TRIGGER_PROMPT,
  parseTriggerFilterDrafts,
  triageDraft,
  triggerFilterDrafts,
  triggerFilterDraftsChanged,
  type TriageDraft,
  type TriggerFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-trigger";
import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@t3tools/shared/projectSettings";
import {
  buildModelOptions,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
} from "../../lib/modelOptions";

export function scheduledTaskDefaultModel(
  config: ServerConfig | null,
  project: (LegacyProjectSettingsFields & { readonly id: ProjectId }) | null,
): ModelSelection | null {
  const settings = config?.settings ?? DEFAULT_SERVER_SETTINGS;
  const configured = resolveProjectSettings(settings, project?.id ?? null, project).settings
    .defaultModelSelection;
  const projectDefaultSelection =
    resolveDefaultableModelSelection(config, configured, project?.id ?? null) ??
    resolveDefaultableModelSelection(config, settings.defaultModelSelection, project?.id ?? null);
  return resolveNewTaskModelSelection({
    draftSelection: null,
    projectDefaultSelection,
    stickySelection: null,
    modelOptions: buildModelOptions(
      config,
      projectDefaultSelection,
      undefined,
      project?.id ?? null,
    ),
  });
}

const TRIGGER_FILTER_MODES: ReadonlySet<string> = new Set([
  "jira",
  "gitlab",
  "slack",
  "jira_query",
  "gitlab_projects",
]);

export function isTriggerFilterMode(mode: string): mode is TriggerFilterSourceKind {
  return TRIGGER_FILTER_MODES.has(mode);
}

export type ScheduleDraft = {
  readonly mode:
    | "fixed_time"
    | "once"
    | "interval"
    | "webhook"
    | TriggerFilterSourceKind
    | "manual";
  readonly timeOfDay: string;
  /** ISO time for a one-time run. Empty until the user picks the "Once" mode. */
  readonly runAt: string;
  /** IANA zone for `timeOfDay`; null means the server's local zone. */
  readonly timeZone: string | null;
  readonly weekdays: ReadonlyArray<number>;
  readonly intervalMinutes: string;
  readonly signature: ScheduledTaskWebhookSignature | null;
  readonly maxDeliveryAgeMinutes: string;
  readonly replayKey: string;
  readonly coalesceKey: string;
  readonly coalesceWindowSeconds: string;
  readonly filters: ReadonlyArray<WebhookFilterDraft>;
  /** The filter rows the form opened with. */
  readonly savedFilters: ReadonlyArray<WebhookFilterDraft>;
  /** `event.` filter rows for the Jira, GitLab, and Slack modes. */
  readonly triggerFilters: ReadonlyArray<TriggerFilterDraft>;
  readonly savedTriggerFilters: ReadonlyArray<TriggerFilterDraft>;
  /** Jira query mode. Mobile edits JQL; a saved filter set on web is kept as it is. */
  readonly jiraSite: string;
  readonly jql: string;
  readonly jiraFilterId: string;
  readonly jiraPollMinutes: string;
  /** GitLab projects mode: project paths are one per line. */
  readonly gitlabHost: string;
  readonly gitlabProjects: string;
  readonly gitlabGroup: string;
  readonly gitlabPollMinutes: string;
};

export const DEFAULT_SCHEDULE: ScheduleDraft = {
  mode: "fixed_time",
  timeOfDay: "09:00",
  runAt: "",
  // New schedules follow the device, not whichever machine hosts the server.
  timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
  weekdays: [1, 2, 3, 4, 5],
  intervalMinutes: "15",
  signature: null,
  maxDeliveryAgeMinutes: "",
  replayKey: "",
  coalesceKey: "",
  coalesceWindowSeconds: "",
  filters: [],
  savedFilters: [],
  triggerFilters: [],
  savedTriggerFilters: [],
  jiraSite: "",
  jql: "",
  jiraFilterId: "",
  jiraPollMinutes: String(DEFAULT_POLL_INTERVAL_MS / 60_000),
  gitlabHost: "",
  gitlabProjects: "",
  gitlabGroup: "",
  gitlabPollMinutes: String(DEFAULT_POLL_INTERVAL_MS / 60_000),
};

export function scheduleDraftForTask(task: Pick<ScheduledTask, "schedule">): ScheduleDraft {
  switch (task.schedule.type) {
    case "fixed_time":
      return {
        ...DEFAULT_SCHEDULE,
        timeOfDay: task.schedule.timeOfDay,
        timeZone: task.schedule.timeZone ?? null,
        weekdays: task.schedule.weekdays?.length
          ? [...new Set(task.schedule.weekdays)].sort((a, b) => a - b)
          : [0, 1, 2, 3, 4, 5, 6],
      };
    case "once":
      return { ...DEFAULT_SCHEDULE, mode: "once", runAt: task.schedule.runAt };
    case "interval":
      return {
        ...DEFAULT_SCHEDULE,
        mode: "interval",
        intervalMinutes: String(Math.max(1, task.schedule.everyMs / 60_000)),
      };
    case "webhook":
      return {
        ...DEFAULT_SCHEDULE,
        mode: "webhook",
        signature: task.schedule.signature,
        replayKey: task.schedule.dedupe?.replayKey ?? "",
        coalesceKey: task.schedule.dedupe?.coalesceKey ?? "",
        coalesceWindowSeconds:
          task.schedule.dedupe?.coalesceWindowSeconds === undefined
            ? ""
            : String(task.schedule.dedupe.coalesceWindowSeconds),
        maxDeliveryAgeMinutes:
          task.schedule.maxDeliveryAgeMinutes == null
            ? ""
            : String(task.schedule.maxDeliveryAgeMinutes),
        filters: webhookFilterDrafts(task.schedule.filters),
        savedFilters: webhookFilterDrafts(task.schedule.filters),
      };
    case "jira":
    case "gitlab":
    case "slack":
      return {
        ...DEFAULT_SCHEDULE,
        mode: task.schedule.type,
        triggerFilters: triggerFilterDrafts(task.schedule.filters),
        savedTriggerFilters: triggerFilterDrafts(task.schedule.filters),
      };
    case "manual":
      return { ...DEFAULT_SCHEDULE, mode: "manual" };
    case "jira_query":
      return {
        ...DEFAULT_SCHEDULE,
        mode: "jira_query",
        triggerFilters: triggerFilterDrafts(task.schedule.filters),
        savedTriggerFilters: triggerFilterDrafts(task.schedule.filters),
        jiraSite: task.schedule.site,
        jql: task.schedule.jql ?? "",
        jiraFilterId: task.schedule.filterId ?? "",
        jiraPollMinutes: String(Math.round(task.schedule.everyMs / 60_000)),
      };
    case "gitlab_projects":
      return {
        ...DEFAULT_SCHEDULE,
        mode: "gitlab_projects",
        triggerFilters: triggerFilterDrafts(task.schedule.filters),
        savedTriggerFilters: triggerFilterDrafts(task.schedule.filters),
        gitlabHost: task.schedule.host,
        gitlabProjects: task.schedule.projects.join("\n"),
        gitlabGroup: task.schedule.group ?? "",
        gitlabPollMinutes: String(Math.round(task.schedule.everyMs / 60_000)),
      };
  }
}

/** Whole minutes, or NaN. */
export function parseJiraPollMinutes(value: string): number {
  const minutes = Number(value.trim());
  return Number.isInteger(minutes) ? minutes : Number.NaN;
}

export function parseIntervalMinutes(value: string): number {
  return Number(value.trim().replace(",", "."));
}

export function scheduleFromDraft(draft: ScheduleDraft): ScheduledTaskUpsertSchedule | null {
  if (draft.mode === "manual") return { type: "manual" };
  if (isTriggerFilterMode(draft.mode)) {
    const parsed = parseTriggerFilterDrafts(draft.triggerFilters, draft.mode);
    if (!("filters" in parsed)) return null;
    if (draft.mode === "gitlab_projects") {
      const everyMs = parseJiraPollMinutes(draft.gitlabPollMinutes) * 60_000;
      const host = draft.gitlabHost.trim();
      const projects = draft.gitlabProjects
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const group = draft.gitlabGroup.trim();
      if (!host || (projects.length === 0 && !group) || !(everyMs >= MIN_POLL_INTERVAL_MS)) {
        return null;
      }
      return {
        type: "gitlab_projects",
        host,
        projects,
        ...(group ? { group } : {}),
        everyMs,
        ...(triggerFilterDraftsChanged(draft.savedTriggerFilters, draft.triggerFilters)
          ? { filters: parsed.filters }
          : {}),
      };
    }
    if (draft.mode === "jira_query") {
      const everyMs = parseJiraPollMinutes(draft.jiraPollMinutes) * 60_000;
      const site = draft.jiraSite.trim();
      const jql = draft.jql.trim();
      const filterId = draft.jiraFilterId.trim();
      if (!site || (!jql && !filterId) || !(everyMs >= MIN_POLL_INTERVAL_MS)) return null;
      return {
        type: "jira_query",
        site,
        ...(filterId ? { filterId } : { jql }),
        everyMs,
        ...(triggerFilterDraftsChanged(draft.savedTriggerFilters, draft.triggerFilters)
          ? { filters: parsed.filters }
          : {}),
      };
    }
    return {
      type: draft.mode,
      // Like webhooks: unedited filters are left out so the server keeps the stored ones.
      ...(triggerFilterDraftsChanged(draft.savedTriggerFilters, draft.triggerFilters)
        ? { filters: parsed.filters }
        : {}),
    };
  }
  if (draft.mode === "webhook") {
    const maxDeliveryAgeMinutes = parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes);
    if (maxDeliveryAgeMinutes === undefined) return null;
    const replayKey = draft.replayKey.trim();
    const coalesceKey = draft.coalesceKey.trim();
    if ([replayKey, coalesceKey].some((key) => key && !isWebhookDedupeTemplate(key))) return null;
    const coalesceWindowSeconds = draft.coalesceWindowSeconds?.trim()
      ? Number(draft.coalesceWindowSeconds)
      : undefined;
    if (
      coalesceWindowSeconds !== undefined &&
      (!Number.isInteger(coalesceWindowSeconds) ||
        coalesceWindowSeconds < 10 ||
        coalesceWindowSeconds > 3600)
    )
      return null;
    const parsedFilters = parseWebhookFilterDrafts(draft.filters);
    if (!("filters" in parsedFilters)) return null;
    // No secret is sent, so the server keeps the stored one.
    return {
      type: "webhook",
      signature:
        draft.signature === null
          ? null
          : {
              header: draft.signature.header,
              encoding: draft.signature.encoding,
              prefix: draft.signature.prefix,
            },
      maxDeliveryAgeMinutes,
      ...(replayKey || coalesceKey || coalesceWindowSeconds !== undefined
        ? {
            dedupe: {
              ...(replayKey ? { replayKey } : {}),
              ...(coalesceKey ? { coalesceKey } : {}),
              ...(coalesceWindowSeconds === undefined ? {} : { coalesceWindowSeconds }),
            },
          }
        : { dedupe: {} }),
      // Only edited filters are sent; the server keeps the stored ones otherwise.
      ...(webhookFilterDraftsChanged(draft.savedFilters, draft.filters)
        ? { filters: parsedFilters.filters }
        : {}),
    };
  }
  if (draft.mode === "once") {
    const runAt = new Date(draft.runAt);
    return Number.isNaN(runAt.getTime()) ? null : { type: "once", runAt: runAt.toISOString() };
  }
  if (draft.mode === "interval") {
    const minutes = parseIntervalMinutes(draft.intervalMinutes);
    const everyMs = Math.round(minutes * 60_000);
    return minutes >= 1 && Number.isSafeInteger(everyMs) ? { type: "interval", everyMs } : null;
  }
  const weekdays = [...new Set(draft.weekdays)].sort((a, b) => a - b);
  if (
    !/^([01]?\d|2[0-3]):[0-5]\d$/.test(draft.timeOfDay) ||
    weekdays.length === 0 ||
    weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  ) {
    return null;
  }
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay,
    ...(draft.timeZone ? { timeZone: draft.timeZone } : {}),
    ...(weekdays.length === 7 ? {} : { weekdays }),
  };
}

type Workspace = "worktree" | "root" | "existing_worktree";
export type ScheduledTaskDraft = {
  readonly task: ScheduledTask | null;
  readonly title: string;
  readonly prompt: string;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
  readonly modelSelection: ModelSelection | null;
  readonly modelSelectionIsExplicit: boolean;
  readonly schedule: ScheduleDraft;
  readonly threadMode: ScheduledTaskThreadMode;
  /** A factory the trigger creates work items in; null for a thread target. */
  readonly factoryId: FactoryId | null;
  readonly workspace: Workspace;
  readonly baseRef: string;
  readonly checkoutPath: string;
  readonly enabled: boolean;
  readonly startFromOrigin: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly triage: TriageDraft;
};

function draftSignature(draft: ScheduledTaskDraft): string {
  return JSON.stringify([
    draft.title,
    draft.prompt,
    draft.projectId,
    draft.threadId,
    draft.modelSelection?.instanceId,
    draft.modelSelection?.model,
    [...(draft.modelSelection?.options ?? [])]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((option) => [option.id, option.value]),
    draft.schedule.mode,
    draft.schedule.timeOfDay,
    draft.schedule.runAt,
    draft.schedule.timeZone,
    [...draft.schedule.weekdays].sort((a, b) => a - b),
    draft.schedule.intervalMinutes,
    draft.schedule.maxDeliveryAgeMinutes,
    draft.schedule.replayKey,
    draft.schedule.coalesceKey,
    draft.schedule.coalesceWindowSeconds,
    draft.schedule.filters.map(({ path, op, value }) => [path, op, value]),
    draft.threadMode,
    draft.factoryId,
    draft.schedule.triggerFilters.map(({ path, op, value }) => [path, op, value]),
    draft.schedule.jiraSite,
    draft.schedule.jql,
    draft.schedule.jiraPollMinutes,
    draft.workspace,
    draft.baseRef,
    draft.checkoutPath,
    draft.enabled,
    draft.startFromOrigin,
    draft.runtimeMode,
    draft.triage.fallback,
    draft.triage.label,
  ]);
}

const DEFAULT_PROMPTS: ReadonlySet<string> = new Set([
  DEFAULT_WEBHOOK_PROMPT,
  ...Object.values(DEFAULT_TRIGGER_PROMPT),
]);

export function switchScheduleMode(
  draft: ScheduledTaskDraft,
  mode: ScheduleDraft["mode"],
  now: number,
): ScheduledTaskDraft {
  // Filter rows belong to one source, so switching sources starts over, or back at the saved rows.
  const triggerFilters =
    isTriggerFilterMode(mode) && draft.task?.schedule.type === mode
      ? scheduleDraftForTask(draft.task).triggerFilters
      : [];
  return {
    ...draft,
    prompt:
      mode === "webhook" && !draft.prompt.trim()
        ? DEFAULT_WEBHOOK_PROMPT
        : isTriggerFilterMode(mode) && !draft.task && DEFAULT_PROMPTS.has(draft.prompt.trim())
          ? DEFAULT_TRIGGER_PROMPT[mode]
          : draft.prompt,
    schedule: {
      ...draft.schedule,
      mode,
      runAt:
        mode === "once" && !draft.schedule.runAt
          ? new Date(Math.ceil(now / 3_600_000) * 3_600_000).toISOString()
          : draft.schedule.runAt,
      ...(isTriggerFilterMode(mode) ? { triggerFilters, savedTriggerFilters: triggerFilters } : {}),
    },
  };
}

export function hasScheduledTaskDraftChanges(
  initial: ScheduledTaskDraft,
  current: ScheduledTaskDraft,
): boolean {
  return draftSignature(initial) !== draftSignature(current);
}

export function moveDraftToThread(
  draft: ScheduledTaskDraft,
  thread: { readonly id: ThreadId; readonly projectId: ProjectId },
): ScheduledTaskDraft {
  return {
    ...draft,
    threadId: thread.id,
    projectId: thread.projectId,
    threadMode: draft.threadMode === "new_thread" ? "continue" : draft.threadMode,
  };
}

/** Leaves the thread but keeps the mode. Matches MCP: new threads stay out of the shared checkout. */
export function unbindDraftFromThread(draft: ScheduledTaskDraft): ScheduledTaskDraft {
  if (draft.threadId === null) return draft;
  return {
    ...draft,
    threadId: null,
    ...(draft.workspace === "root"
      ? { workspace: "worktree" as const, startFromOrigin: true }
      : {}),
  };
}

export function changeDraftProject(
  draft: ScheduledTaskDraft,
  projectId: ProjectId,
): ScheduledTaskDraft {
  if (projectId === draft.projectId) return draft;
  return { ...unbindDraftFromThread(draft), projectId };
}

export function createDraft(
  projectId: ProjectId | null,
  modelSelection: ModelSelection | null,
): ScheduledTaskDraft {
  return {
    task: null,
    title: "",
    prompt: "",
    projectId,
    threadId: null,
    modelSelection,
    modelSelectionIsExplicit: false,
    schedule: DEFAULT_SCHEDULE,
    threadMode: "new_thread",
    factoryId: null,
    workspace: "worktree",
    baseRef: "main",
    checkoutPath: "",
    enabled: true,
    startFromOrigin: true,
    runtimeMode: "full-access",
    triage: triageDraft(undefined),
  };
}

export function editDraft(task: ScheduledTask): ScheduledTaskDraft {
  return {
    task,
    title: task.title,
    prompt: task.prompt,
    projectId: task.projectId,
    threadId: task.threadId,
    modelSelection: task.modelSelection,
    modelSelectionIsExplicit: true,
    schedule: scheduleDraftForTask(task),
    threadMode: scheduledTaskThreadMode(task),
    factoryId: task.target?.factoryId ?? null,
    workspace: task.workspaceStrategy.type,
    baseRef: task.workspaceStrategy.type === "worktree" ? task.workspaceStrategy.baseRef : "main",
    checkoutPath:
      task.workspaceStrategy.type === "existing_worktree"
        ? task.workspaceStrategy.worktreePath
        : "",
    enabled: task.enabled,
    startFromOrigin:
      task.workspaceStrategy.type === "worktree"
        ? (task.workspaceStrategy.startFromOrigin ?? false)
        : true,
    runtimeMode: task.runtimeMode,
    triage: triageDraft(task.triage),
  };
}

/**
 * The save's target: a work item target for a chosen factory, null to turn a stored one back into
 * a thread target, and nothing otherwise, so servers that predate targets accept the save.
 */
export function draftTarget(
  draft: Pick<ScheduledTaskDraft, "task" | "factoryId">,
  projectId: ProjectId,
): Pick<ScheduledTaskUpsertInput, "target"> {
  if (draft.factoryId !== null) {
    return { target: { type: "work_item", projectId, factoryId: draft.factoryId } };
  }
  return draft.task?.target === undefined ? {} : { target: null };
}
