import {
  isListedThreadLineage,
  isWebhookDedupeTemplate,
  parseFactoryId,
  type ScheduledTaskTimeSchedule,
  type Trigger,
  type TriggerFilterSourceKind,
} from "@t3tools/contracts";
import {
  DEFAULT_POLL_INTERVAL_MS,
  EnvironmentId,
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  MIN_POLL_INTERVAL_MS,
  type ProjectId,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskSchedule,
  type ScheduledTaskThreadMode,
  type ScheduledTaskUpsertInput,
  type ScheduledTaskUpsertSchedule,
  type FactoryId,
  scheduledTaskThreadMode,
  type ModelSelection,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  DEFAULT_TRIGGER_PROMPT,
  parseTriggerFilterDrafts,
  triageDraft,
  triggerFilterDrafts,
  triggerFilterDraftsChanged,
  triggerFiltersSummary,
  type TriageDraft,
  type TriggerFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-trigger";
import {
  DEFAULT_WEBHOOK_PROMPT,
  parseMaxDeliveryAge,
  parseWebhookFilterDrafts,
  webhookFilterDrafts,
  webhookFilterDraftsChanged,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
import { scheduleTimeZoneLabel } from "@t3tools/client-runtime/scheduled-task-time-zone";

import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@t3tools/shared/projectSettings";
import type { ProviderInstanceEntry } from "../../providerInstances";

import type { ResolvedSettingsScope } from "./settingsScope";

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function scheduleLabel(
  schedule: ScheduledTaskSchedule,
  timeZone?: string,
  runAt?: string | null,
): string {
  if (schedule.type === "interval" || schedule.type === "fixed_time" || schedule.type === "once") {
    return timeScheduleLabel(schedule, timeZone, runAt);
  }
  if (schedule.type === "webhook") return SCHEDULE_MODE_LABELS.webhook;
  if (schedule.type === "manual") return SCHEDULE_MODE_LABELS.manual;
  const count = schedule.filters?.length ?? 0;
  const label = SCHEDULE_MODE_LABELS[schedule.type];
  return count === 0 ? label : `${label} · ${count} filter${count === 1 ? "" : "s"}`;
}

export function matchesScheduledTaskScope(
  scope: ResolvedSettingsScope,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): boolean {
  if (scope.kind === "unavailable" || !scope.environmentIds.includes(environmentId)) return false;
  if (scope.kind === "project" || scope.kind === "checkout") {
    return scope.members.some(
      (member) => member.environmentId === environmentId && member.id === projectId,
    );
  }
  return true;
}

export function validateScheduledTasksSearch(raw: Record<string, unknown>) {
  return {
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.taskId === "string" && raw.taskId.trim()
      ? { taskId: ScheduledTaskId.make(raw.taskId) }
      : {}),
  };
}

export type ScheduleMode =
  | "fixed"
  | "once"
  | "interval"
  | "webhook"
  | "jira"
  | "gitlab"
  | "slack"
  | "manual"
  | "jira_query"
  | "gitlab_projects";

export const SCHEDULE_MODE_LABELS: Record<ScheduleMode, string> = {
  fixed: "At a time",
  once: "Once",
  interval: "Every interval",
  webhook: "On webhook",
  jira: "On Jira change",
  gitlab: "On GitLab change",
  slack: "On Slack message",
  manual: "Manual",
  jira_query: "On Jira query",
  gitlab_projects: "On GitLab projects",
};

/** Source picker entries: the schedule kinds sit under "Schedule", the event sources beside it. */
export const TRIGGER_SOURCE_LABELS: Record<Trigger["source"]["kind"], string> = {
  schedule: "Schedule",
  webhook: "Webhook",
  jira: "Jira",
  gitlab: "GitLab",
  slack: "Slack",
  manual: "Manual",
  jira_query: "Jira query",
  gitlab_projects: "GitLab projects",
};

export const TIME_SCHEDULE_MODES = ["fixed", "once", "interval"] as const;

export function triggerSourceOfMode(mode: ScheduleMode): Trigger["source"]["kind"] {
  return mode === "fixed" || mode === "once" || mode === "interval" ? "schedule" : mode;
}

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const ONCE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** `timeZone` is the server's, which a fixed-time schedule without its own zone runs in. */
export function timeScheduleLabel(
  schedule: ScheduledTaskTimeSchedule,
  timeZone?: string,
  runAt?: string | null,
): string {
  if (schedule.type === "once") return `Once, ${ONCE_FORMATTER.format(new Date(schedule.runAt))}`;
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    if (!Number.isInteger(minutes)) return `Every ${Math.round(schedule.everyMs / 1000)} seconds`;
    return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => WEEKDAY_LABELS[day]).join(", ");
  const zone = scheduleTimeZoneLabel(schedule.timeZone ?? timeZone, runAt);
  return `${days} at ${schedule.timeOfDay}${zone === undefined ? "" : ` ${zone}`}`;
}

/**
 * One line per trigger: its source, then what it filters on, such as "Jira · Status equals Done",
 * and the factory a work item trigger feeds.
 */
export function triggerSummary(
  trigger: Pick<Trigger, "source" | "filters"> & { readonly target?: Trigger["target"] },
  timeZone?: string,
  runAt?: string | null,
): string {
  const summary = triggerSourceSummary(trigger, timeZone, runAt);
  const { target } = trigger;
  if (target?.type !== "work_item") return summary;
  return `${summary} → ${parseFactoryId(target.factoryId)?.name ?? target.factoryId}`;
}

function triggerSourceSummary(
  trigger: Pick<Trigger, "source" | "filters">,
  timeZone?: string,
  runAt?: string | null,
): string {
  const { source, filters } = trigger;
  if (source.kind === "schedule") return timeScheduleLabel(source.schedule, timeZone, runAt);
  const label = TRIGGER_SOURCE_LABELS[source.kind];
  if (source.kind === "jira_query" || source.kind === "gitlab_projects") {
    const parts = [label];
    if (source.kind === "gitlab_projects") {
      const count = source.projects.length;
      if (count > 0) parts.push(`${count} project${count === 1 ? "" : "s"}`);
      if (source.group !== undefined) parts.push(`group ${source.group}`);
    }
    parts.push(`every ${Math.round(source.everyMs / 60_000)} minutes`);
    if (filters.length > 0) parts.push(triggerFiltersSummary(source.kind, filters));
    return parts.join(" · ");
  }
  if (source.kind === "manual" || filters.length === 0) return label;
  if (source.kind === "webhook") {
    return `${label} · ${filters.length} filter${filters.length === 1 ? "" : "s"}`;
  }
  return `${label} · ${triggerFiltersSummary(source.kind, filters)}`;
}

export function isTriggerFilterSource(mode: string): mode is TriggerFilterSourceKind {
  return (
    mode === "jira" ||
    mode === "gitlab" ||
    mode === "slack" ||
    mode === "jira_query" ||
    mode === "gitlab_projects"
  );
}

const DEFAULT_PROMPTS = new Set<string>([
  DEFAULT_WEBHOOK_PROMPT,
  ...Object.values(DEFAULT_TRIGGER_PROMPT),
]);

/** A blank prompt, or one still at another mode's default, takes the new mode's default. */
export function promptForScheduleMode(mode: ScheduleMode, prompt: string): string {
  if (prompt.trim() !== "" && !DEFAULT_PROMPTS.has(prompt)) return prompt;
  if (mode === "webhook") return DEFAULT_WEBHOOK_PROMPT;
  if (isTriggerFilterSource(mode)) return DEFAULT_TRIGGER_PROMPT[mode];
  return "";
}

/** The zone new fixed-time schedules start in: wherever the person editing is. */
export const localTimeZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;
export type WorkspaceMode = "root" | "worktree" | "existing_worktree";

export interface DraftState {
  readonly editingId: string | null;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly scheduleMode: ScheduleMode;
  readonly intervalMinutes: string;
  readonly timeOfDay: string;
  /** Local date and time as a `datetime-local` input value, such as 2026-11-02T15:00. */
  readonly runAt: string;
  /** The stored ISO run time, sent back unchanged when the field was not edited. */
  readonly savedRunAt: string;
  /** IANA zone for `timeOfDay`; empty means the server's local zone. */
  readonly timeZone: string;
  readonly weekdays: ReadonlySet<number>;
  readonly projectId: string;
  readonly threadId: string;
  readonly threadMode: ScheduledTaskThreadMode;
  /** A factory the trigger creates work items in; empty for a thread target. */
  readonly factoryId: string;
  readonly workspaceMode: WorkspaceMode;
  readonly baseRef: string;
  readonly startFromOrigin: boolean;
  readonly existingWorktreePath: string;
  readonly modelKey: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** Retain the source selection's provider options when the picker leaves instanceId:model unchanged. */
  readonly baseModelSelection: ModelSelection | null;
  readonly signatureEnabled: boolean;
  readonly signatureHeader: string;
  readonly signatureEncoding: "hex" | "base64";
  readonly signaturePrefix: string;
  /** Write-only: empty keeps the secret already stored on the server. */
  readonly signatureSecret: string;
  readonly maxDeliveryAgeMinutes: string;
  readonly replayKey: string;
  readonly coalesceKey: string;
  readonly coalesceWindowSeconds: string;
  readonly filters: ReadonlyArray<WebhookFilterDraft>;
  /** The filter rows the form opened with. */
  readonly savedFilters: ReadonlyArray<WebhookFilterDraft>;
  /** Event filters for the Jira, GitLab, and Slack modes; paths are fields of that source. */
  readonly triggerFilters: ReadonlyArray<TriggerFilterDraft>;
  readonly savedTriggerFilters: ReadonlyArray<TriggerFilterDraft>;
  /** Jira query mode: the site, a JQL or saved filter, and the poll interval. */
  readonly jiraSite: string;
  readonly jiraQueryKind: "jql" | "filter";
  readonly jql: string;
  readonly jiraFilterId: string;
  readonly jiraPollMinutes: string;
  /** GitLab projects mode: the host, project paths one per line, a group, and the interval. */
  readonly gitlabHost: string;
  readonly gitlabProjects: string;
  readonly gitlabGroup: string;
  readonly gitlabPollMinutes: string;
  readonly triage: TriageDraft;
}

export const JIRA_QUERY_DRAFT_DEFAULTS = {
  jiraSite: "",
  jiraQueryKind: "jql",
  jql: "",
  jiraFilterId: "",
  jiraPollMinutes: String(DEFAULT_POLL_INTERVAL_MS / 60_000),
} as const;

export const GITLAB_PROJECTS_DRAFT_DEFAULTS = {
  gitlabHost: "",
  gitlabProjects: "",
  gitlabGroup: "",
  gitlabPollMinutes: String(DEFAULT_POLL_INTERVAL_MS / 60_000),
} as const;

const MIN_POLL_MINUTES = MIN_POLL_INTERVAL_MS / 60_000;

const gitlabProjectPaths = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const invalidPollInterval = (value: string) => {
  const minutes = Number(value);
  return !Number.isInteger(minutes) || minutes < MIN_POLL_MINUTES
    ? [
        {
          title: "Invalid interval",
          description: `Poll every ${MIN_POLL_MINUTES} minutes or more, in whole minutes.`,
        },
      ]
    : [];
};

export const WEBHOOK_SIGNATURE_DEFAULTS = {
  signatureHeader: "x-hub-signature-256",
  signatureEncoding: "hex",
  signaturePrefix: "sha256=",
} as const;

/** Formats a date as a `datetime-local` input value in the browser's time zone. */
export function toDateTimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function scheduleDraftErrors(draft: DraftState) {
  if (draft.scheduleMode === "once") {
    const runAt = new Date(draft.runAt);
    if (Number.isNaN(runAt.getTime()))
      return [{ title: "Invalid run time", description: "Pick a date and time." }];
    // A time skipped by a daylight saving change parses to a different clock time.
    if (toDateTimeLocalValue(runAt) !== draft.runAt)
      return [
        { title: "Invalid run time", description: "That time does not exist in your time zone." },
      ];
    return [];
  }
  if (draft.scheduleMode === "gitlab_projects") {
    if (!draft.gitlabHost.trim())
      return [{ title: "GitLab host is required", description: "Pick the GitLab host to poll." }];
    if (gitlabProjectPaths(draft.gitlabProjects).length === 0 && !draft.gitlabGroup.trim())
      return [
        {
          title: "Projects are required",
          description: "Enter project paths, one per line, or a group.",
        },
      ];
    return invalidPollInterval(draft.gitlabPollMinutes);
  }
  if (draft.scheduleMode === "jira_query") {
    if (!draft.jiraSite.trim())
      return [{ title: "Jira site is required", description: "Pick the Jira site to query." }];
    if (draft.jiraQueryKind === "jql" ? !draft.jql.trim() : !draft.jiraFilterId.trim())
      return [
        {
          title: "Jira query is required",
          description:
            draft.jiraQueryKind === "jql" ? "Enter a JQL query." : "Pick a saved filter.",
        },
      ];
    return invalidPollInterval(draft.jiraPollMinutes);
  }
  if (draft.scheduleMode !== "webhook") return [];
  if (parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes) === undefined)
    return [
      {
        title: "Invalid age limit",
        description: `Enter whole minutes from 1 to ${MAX_WEBHOOK_DELIVERY_AGE_MINUTES}, or leave it blank.`,
      },
    ];
  const errors: Array<{ title: string; description: string }> = [];
  for (const [label, value] of [
    ["Duplicate request key", draft.replayKey],
    ["Coalesce key", draft.coalesceKey],
  ] as const) {
    if (value.trim() && !isWebhookDedupeTemplate(value.trim()))
      errors.push({
        title: "Invalid webhook settings",
        description: `${label} must contain a valid request placeholder.`,
      });
  }
  const window = draft.coalesceWindowSeconds.trim();
  if (window && (!Number.isInteger(Number(window)) || Number(window) < 10 || Number(window) > 3600))
    errors.push({
      title: "Invalid webhook settings",
      description: "Coalesce window must be whole seconds from 10 to 3600.",
    });
  return errors;
}

export function webhookDeliveryLabel(delivery: {
  readonly outcome: string;
  readonly pendingWindow?: boolean | undefined;
}) {
  if (delivery.outcome === "accepted") return delivery.pendingWindow ? "Opened window" : "Ran";
  const labels: Record<string, string> = {
    dispatch_failed: "Run failed",
    duplicate: "Duplicate",
    coalesced: "Coalesced",
    filtered: "Filtered",
    rejected_signature: "Bad signature",
    disabled: "Task paused",
    rate_limited: "Rate limited",
    expired: "Too old",
  };
  return labels[delivery.outcome] ?? delivery.outcome.replaceAll("_", " ");
}

export function scheduleFromDraft(draft: DraftState): ScheduledTaskUpsertSchedule | null {
  if (scheduleDraftErrors(draft).length > 0) return null;
  if (draft.scheduleMode === "once") {
    const saved = draft.savedRunAt ? new Date(draft.savedRunAt) : null;
    if (saved !== null && toDateTimeLocalValue(saved) === draft.runAt)
      return { type: "once", runAt: draft.savedRunAt };
    // A `datetime-local` value has no offset. In an hour that repeats when clocks go
    // back, keep the saved time's offset; otherwise Date reads it as local time.
    const withSavedOffset =
      saved === null
        ? null
        : new Date(Date.parse(`${draft.runAt}Z`) + saved.getTimezoneOffset() * 60_000);
    return {
      type: "once",
      runAt:
        withSavedOffset !== null && toDateTimeLocalValue(withSavedOffset) === draft.runAt
          ? withSavedOffset.toISOString()
          : new Date(draft.runAt).toISOString(),
    };
  }
  if (draft.scheduleMode === "webhook") {
    const maxDeliveryAgeMinutes = parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes);
    const replayKey = draft.replayKey.trim();
    const coalesceKey = draft.coalesceKey.trim();
    const coalesceWindowSeconds = draft.coalesceWindowSeconds.trim()
      ? Number(draft.coalesceWindowSeconds)
      : undefined;
    if (maxDeliveryAgeMinutes === undefined) return null;
    const parsedFilters = parseWebhookFilterDrafts(draft.filters);
    if (!("filters" in parsedFilters)) return null;
    const secret = draft.signatureSecret.trim();
    return {
      type: "webhook",
      signature: draft.signatureEnabled
        ? {
            header: draft.signatureHeader.trim(),
            encoding: draft.signatureEncoding,
            prefix: draft.signaturePrefix,
            ...(secret ? { secret } : {}),
          }
        : null,
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
  if (isTriggerFilterSource(draft.scheduleMode)) {
    const parsed = parseTriggerFilterDrafts(draft.triggerFilters, draft.scheduleMode);
    if (!("filters" in parsed)) return null;
    if (draft.scheduleMode === "gitlab_projects") {
      const host = draft.gitlabHost.trim();
      const projects = gitlabProjectPaths(draft.gitlabProjects);
      const group = draft.gitlabGroup.trim();
      const everyMs = Number(draft.gitlabPollMinutes) * 60_000;
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
    if (draft.scheduleMode === "jira_query") {
      return {
        type: "jira_query",
        site: draft.jiraSite.trim(),
        ...(draft.jiraQueryKind === "jql"
          ? { jql: draft.jql.trim() }
          : { filterId: draft.jiraFilterId.trim() }),
        everyMs: Number(draft.jiraPollMinutes) * 60_000,
        ...(triggerFilterDraftsChanged(draft.savedTriggerFilters, draft.triggerFilters)
          ? { filters: parsed.filters }
          : {}),
      };
    }
    return {
      type: draft.scheduleMode,
      ...(triggerFilterDraftsChanged(draft.savedTriggerFilters, draft.triggerFilters)
        ? { filters: parsed.filters }
        : {}),
    };
  }
  if (draft.scheduleMode === "manual") return { type: "manual" };
  if (draft.scheduleMode === "interval") {
    const everyMs = Math.round(Number(draft.intervalMinutes) * 60_000);
    return { type: "interval", everyMs };
  }
  const selectedEveryDay = draft.weekdays.size === 0 || draft.weekdays.size === 7;
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay || "09:00",
    ...(draft.timeZone ? { timeZone: draft.timeZone } : {}),
    ...(selectedEveryDay ? {} : { weekdays: [...draft.weekdays].toSorted() }),
  };
}

/**
 * The save's target: a work item target for a chosen factory, null to turn a stored one back into
 * a thread target, and nothing otherwise, so servers that predate targets accept the save.
 */
export function targetFromDraft(
  draft: Pick<DraftState, "factoryId">,
  projectId: ProjectId,
  stored: Pick<ScheduledTask, "target"> | null,
): Pick<ScheduledTaskUpsertInput, "target"> {
  if (draft.factoryId) {
    return { target: { type: "work_item", projectId, factoryId: draft.factoryId as FactoryId } };
  }
  return stored?.target === undefined ? {} : { target: null };
}

/** A new trigger made from a factory's page: its project, creating work items in it. */
export function draftForFactoryTrigger(factory: {
  readonly id: FactoryId;
  readonly projectId: ProjectId;
}): Pick<DraftState, "projectId" | "factoryId"> {
  return { projectId: factory.projectId, factoryId: factory.id };
}

export function taskToDraft(task: ScheduledTask): DraftState {
  const schedule = task.schedule;
  const filters = webhookFilterDrafts(schedule.type === "webhook" ? schedule.filters : undefined);
  const triggerFilters = triggerFilterDrafts(
    schedule.type === "jira" ||
      schedule.type === "gitlab" ||
      schedule.type === "slack" ||
      schedule.type === "jira_query" ||
      schedule.type === "gitlab_projects"
      ? schedule.filters
      : undefined,
  );
  const weekdays =
    schedule.type === "fixed_time" && schedule.weekdays && schedule.weekdays.length > 0
      ? new Set(schedule.weekdays)
      : new Set([0, 1, 2, 3, 4, 5, 6]);
  return {
    editingId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    scheduleMode: schedule.type === "fixed_time" ? "fixed" : schedule.type,
    intervalMinutes:
      schedule.type === "interval" ? String(Math.max(1, schedule.everyMs / 60_000)) : "15",
    // A time input shows nothing for an unpadded hour such as 9:05, which agents may save.
    timeOfDay: schedule.type === "fixed_time" ? schedule.timeOfDay.padStart(5, "0") : "09:00",
    runAt: schedule.type === "once" ? toDateTimeLocalValue(new Date(schedule.runAt)) : "",
    savedRunAt: schedule.type === "once" ? schedule.runAt : "",
    timeZone: schedule.type === "fixed_time" ? (schedule.timeZone ?? "") : localTimeZone(),
    weekdays,
    projectId: task.projectId,
    threadId: task.threadId ?? "",
    threadMode: scheduledTaskThreadMode(task),
    factoryId: task.target?.factoryId ?? "",
    workspaceMode: task.workspaceStrategy.type,
    baseRef: task.workspaceStrategy.type === "worktree" ? task.workspaceStrategy.baseRef : "main",
    startFromOrigin:
      task.workspaceStrategy.type === "worktree"
        ? (task.workspaceStrategy.startFromOrigin ?? false)
        : true,
    existingWorktreePath:
      task.workspaceStrategy.type === "existing_worktree"
        ? task.workspaceStrategy.worktreePath
        : "",
    modelKey: `${task.modelSelection.instanceId}:${task.modelSelection.model}`,
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
    baseModelSelection: task.modelSelection,
    ...(schedule.type === "webhook" && schedule.signature !== null
      ? {
          signatureEnabled: true,
          signatureHeader: schedule.signature.header,
          signatureEncoding: schedule.signature.encoding,
          signaturePrefix: schedule.signature.prefix,
        }
      : { signatureEnabled: false, ...WEBHOOK_SIGNATURE_DEFAULTS }),
    signatureSecret: "",
    replayKey: schedule.type === "webhook" ? (schedule.dedupe?.replayKey ?? "") : "",
    coalesceKey: schedule.type === "webhook" ? (schedule.dedupe?.coalesceKey ?? "") : "",
    coalesceWindowSeconds:
      schedule.type === "webhook" && schedule.dedupe?.coalesceWindowSeconds !== undefined
        ? String(schedule.dedupe.coalesceWindowSeconds)
        : "",
    maxDeliveryAgeMinutes:
      schedule.type === "webhook" && schedule.maxDeliveryAgeMinutes != null
        ? String(schedule.maxDeliveryAgeMinutes)
        : "",
    filters,
    savedFilters: filters,
    triggerFilters,
    savedTriggerFilters: triggerFilters,
    ...(schedule.type === "jira_query"
      ? {
          jiraSite: schedule.site,
          jiraQueryKind: schedule.filterId === undefined ? "jql" : "filter",
          jql: schedule.jql ?? "",
          jiraFilterId: schedule.filterId ?? "",
          jiraPollMinutes: String(Math.round(schedule.everyMs / 60_000)),
        }
      : JIRA_QUERY_DRAFT_DEFAULTS),
    ...(schedule.type === "gitlab_projects"
      ? {
          gitlabHost: schedule.host,
          gitlabProjects: schedule.projects.join("\n"),
          gitlabGroup: schedule.group ?? "",
          gitlabPollMinutes: String(Math.round(schedule.everyMs / 60_000)),
        }
      : GITLAB_PROJECTS_DRAFT_DEFAULTS),
    triage: triageDraft(task.triage),
  };
}

export function moveDraftToThread(
  draft: DraftState,
  thread: { readonly id: ThreadId; readonly projectId: ProjectId },
): DraftState {
  return {
    ...draft,
    threadId: thread.id,
    projectId: thread.projectId,
    threadMode: draft.threadMode === "new_thread" ? "continue" : draft.threadMode,
  };
}

/** Leaves the thread but keeps the mode. Matches MCP: new threads stay out of the shared checkout. */
export function unbindDraftFromThread(draft: DraftState): DraftState {
  if (!draft.threadId) return draft;
  return {
    ...draft,
    threadId: "",
    ...(draft.workspaceMode === "root"
      ? { workspaceMode: "worktree" as const, startFromOrigin: true }
      : {}),
  };
}

export function changeDraftProject(draft: DraftState, projectId: string): DraftState {
  if (projectId === draft.projectId) return draft;
  return { ...unbindDraftFromThread(draft), projectId };
}

/** Threads a task can move to. The current one is left out; the picker always shows it. */
export function scheduledTaskDestinationThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  target: {
    readonly environmentId: EnvironmentId;
    readonly projectId: string;
    readonly currentThreadId: ThreadId | null;
    readonly query: string;
  },
): ReadonlyArray<EnvironmentThreadShell> {
  const search = target.query.trim().toLocaleLowerCase();
  return threads
    .filter(
      (thread) =>
        thread.environmentId === target.environmentId &&
        thread.projectId === target.projectId &&
        thread.id !== target.currentThreadId &&
        thread.archivedAt === null &&
        isListedThreadLineage(thread.lineage) &&
        thread.title.toLocaleLowerCase().includes(search),
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function scheduledTaskDefaultModel(
  settings: ServerSettings,
  project: (LegacyProjectSettingsFields & { readonly id: ProjectId }) | null,
  entries: readonly ProviderInstanceEntry[],
): ModelSelection | null {
  const available = entries.filter(
    (entry) =>
      entry.enabled &&
      entry.installed &&
      entry.isAvailable &&
      entry.snapshot.auth.status !== "unauthenticated",
  );
  const configured = resolveProjectSettings(settings, project?.id ?? null, project).settings
    .defaultModelSelection;
  for (const selection of [configured, settings.defaultModelSelection]) {
    if (
      selection &&
      available.some(
        (entry) =>
          entry.instanceId === selection.instanceId &&
          entry.models.find((model) => model.slug === selection.model)?.isLegacy !== true,
      )
    )
      return selection;
  }
  const models = available.flatMap((entry) =>
    entry.models
      .filter((model) => !model.isLegacy)
      .map((model) => ({ instanceId: entry.instanceId, model })),
  );
  const fallback = models.find(({ model }) => model.isDefault) ?? models[0];
  return fallback ? { instanceId: fallback.instanceId, model: fallback.model.slug } : null;
}

/**
 * A new task's project: a pinned open project, then any open one. An archived
 * project only when Settings is scoped to it, so that scope can still save.
 */
export function defaultScheduledTaskProjectId<
  TProject extends {
    readonly id: ProjectId;
    readonly pinnedAt?: string | null | undefined;
    readonly archivedAt?: string | null | undefined;
  },
>(scopedProjects: ReadonlyArray<TProject>, scope: ResolvedSettingsScope): ProjectId | "" {
  const open = scopedProjects.filter((project) => project.archivedAt == null);
  const scopedToProject = scope.kind === "project" || scope.kind === "checkout";
  return (
    (
      open.find((project) => project.pinnedAt != null) ??
      open[0] ??
      (scopedToProject ? scopedProjects[0] : undefined)
    )?.id ?? ""
  );
}
