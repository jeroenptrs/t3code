import * as Schema from "effect/Schema";

import {
  CommandId,
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { DEFAULT_MODEL } from "./model.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2ThreadLaunchWorkspaceStrategy } from "./orchestrationV2.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProviderInteractionMode,
  RuntimeMode,
} from "./providerPolicy.ts";
import {
  gitlabProjectsFields,
  hasGitLabProjects,
  isOneJiraQuery,
  jiraQueryFields,
  MAX_WEBHOOK_FILTERS,
  makeFilterSchema,
  ScheduledTask,
  ScheduledTaskThreadMode,
  ScheduledTaskTimeSchedule,
  ScheduledTaskUpsertInput,
  ScheduledTaskUpsertTimeSchedule,
  ScheduledTaskUpsertWebhookSchedule,
  ScheduledTaskWebhookFilter,
  ScheduledTaskWebhookSchedule,
  scheduledTaskThreadMode,
  TriggerFilter,
  TriggerWorkItemTarget,
  type ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";

export const TriggerSourceKind = Schema.Literals([
  "schedule",
  "webhook",
  "slack",
  "jira",
  "gitlab",
  "manual",
  "jira_query",
  "gitlab_projects",
]);
export type TriggerSourceKind = typeof TriggerSourceKind.Type;

/** Sources that raise events with fields a filter can select on. */
export const TriggerFilterSourceKind = Schema.Literals([
  "jira",
  "gitlab",
  "slack",
  "jira_query",
  "gitlab_projects",
]);
export type TriggerFilterSourceKind = typeof TriggerFilterSourceKind.Type;

export const TRIGGER_EVENT_TYPES = {
  jira: ["issue.status_changed", "issue.labels_changed", "issue.assignee_changed"],
  gitlab: [
    "merge_request.opened",
    "merge_request.updated",
    "merge_request.merged",
    "merge_request.closed",
    "pipeline.failed",
    "pipeline.passed",
  ],
  slack: ["message"],
  manual: ["manual"],
  jira_query: [
    "issue.entered",
    "issue.left",
    "issue.status_changed",
    "issue.labels_changed",
    "issue.assignee_changed",
    "issue.updated",
  ],
  gitlab_projects: [
    "merge_request.opened",
    "merge_request.updated",
    "merge_request.merged",
    "merge_request.closed",
    "pipeline.finished",
  ],
} as const;

export interface TriggerSourceField {
  readonly path: `event.${string}`;
  readonly label: string;
  readonly description: string;
  readonly array?: true;
}

const JIRA_SOURCE_FIELDS = [
  { path: "event.type", label: "Event type", description: "What changed on the issue." },
  {
    path: "event.site",
    label: "Site",
    description: "Jira site host, such as acme.atlassian.net.",
  },
  { path: "event.key", label: "Issue key", description: "Issue key, such as PROJ-123." },
  {
    path: "event.projectKey",
    label: "Project key",
    description: "Jira project key, such as PROJ.",
  },
  { path: "event.url", label: "URL", description: "Link to the issue." },
  { path: "event.summary", label: "Summary", description: "Issue summary." },
  { path: "event.status", label: "Status", description: "Current status name." },
  {
    path: "event.statusCategory",
    label: "Status category",
    description: "todo, in-progress, or done.",
  },
  {
    path: "event.previousStatus",
    label: "Previous status",
    description: "Status before this change. Empty the first time the issue is seen.",
  },
  {
    path: "event.previousStatusCategory",
    label: "Previous status category",
    description: "Status category before this change.",
  },
  { path: "event.issueType", label: "Issue type", description: "Such as Bug or Story." },
  { path: "event.priority", label: "Priority", description: "Priority name." },
  { path: "event.assignee", label: "Assignee", description: "Assignee display name." },
  {
    path: "event.assigneeAccountId",
    label: "Assignee account ID",
    description: "Atlassian account ID of the assignee.",
  },
  {
    path: "event.previousAssigneeAccountId",
    label: "Previous assignee account ID",
    description: "Atlassian account ID of the assignee before this change.",
  },
  { path: "event.labels", label: "Labels", description: "Labels on the issue.", array: true },
  {
    path: "event.addedLabels",
    label: "Added labels",
    description: "Labels this change added.",
    array: true,
  },
  {
    path: "event.removedLabels",
    label: "Removed labels",
    description: "Labels this change removed.",
    array: true,
  },
] as const satisfies ReadonlyArray<TriggerSourceField>;

const GITLAB_SOURCE_FIELDS = [
  { path: "event.type", label: "Event type", description: "What changed on the merge request." },
  { path: "event.host", label: "Host", description: "GitLab host, such as gitlab.com." },
  {
    path: "event.repository",
    label: "Repository",
    description: "Project path, such as group/app.",
  },
  { path: "event.number", label: "Number", description: "Merge request number." },
  { path: "event.url", label: "URL", description: "Link to the merge request." },
  { path: "event.title", label: "Title", description: "Merge request title." },
  { path: "event.state", label: "State", description: "open, merged, or closed." },
  {
    path: "event.previousState",
    label: "Previous state",
    description: "State before this change.",
  },
  { path: "event.isDraft", label: "Draft", description: "true or false." },
  {
    path: "event.headBranch",
    label: "Source branch",
    description: "Branch the changes come from.",
  },
  {
    path: "event.baseBranch",
    label: "Target branch",
    description: "Branch the changes merge into.",
  },
  {
    path: "event.checksState",
    label: "Pipeline",
    description: "passing, failing, or pending.",
  },
  {
    path: "event.previousChecksState",
    label: "Previous pipeline",
    description: "Pipeline state before this change.",
  },
  {
    path: "event.reviewDecision",
    label: "Review decision",
    description: "Approval state of the merge request.",
  },
  { path: "event.author", label: "Author", description: "Author's username." },
] as const satisfies ReadonlyArray<TriggerSourceField>;

export const TRIGGER_SOURCE_FIELDS = {
  jira: JIRA_SOURCE_FIELDS,
  jira_query: [
    ...JIRA_SOURCE_FIELDS,
    {
      path: "event.changedFields",
      label: "Changed fields",
      description:
        "Watched fields this poll saw change: status, labels, assignee, and the fields filters name.",
      array: true,
    },
    { path: "event.query", label: "Query", description: "The JQL, or the saved filter's name." },
  ],
  gitlab: GITLAB_SOURCE_FIELDS,
  gitlab_projects: [
    ...GITLAB_SOURCE_FIELDS,
    {
      path: "event.pipelineStatus",
      label: "Pipeline status",
      description: "success, failed, canceled, or skipped. Set on pipeline.finished.",
    },
    { path: "event.pipelineUrl", label: "Pipeline URL", description: "Link to the pipeline." },
    {
      path: "event.pipelineRef",
      label: "Pipeline ref",
      description: "Branch or tag the pipeline ran for.",
    },
  ],
  slack: [
    { path: "event.type", label: "Event type", description: "Always message." },
    { path: "event.tenantId", label: "Workspace", description: "Slack workspace ID." },
    { path: "event.surface", label: "Surface", description: "Where the message came from." },
    {
      path: "event.invocationId",
      label: "Invocation ID",
      description: "Unique ID of the message.",
    },
    { path: "event.prompt", label: "Message", description: "The message text sent to T3 Code." },
  ],
} as const satisfies Record<TriggerFilterSourceKind, ReadonlyArray<TriggerSourceField>>;

const NullableString = Schema.NullOr(Schema.String);
const StringList = Schema.Array(Schema.String);

export const TriggerJiraEventType = Schema.Literals(TRIGGER_EVENT_TYPES.jira);
export type TriggerJiraEventType = typeof TriggerJiraEventType.Type;

export const TriggerJiraEventPayload = Schema.Struct({
  type: TriggerJiraEventType,
  site: Schema.String,
  key: Schema.String,
  projectKey: Schema.String,
  url: Schema.String,
  summary: Schema.String,
  status: Schema.String,
  statusCategory: Schema.String,
  previousStatus: NullableString,
  previousStatusCategory: NullableString,
  issueType: NullableString,
  priority: NullableString,
  assignee: NullableString,
  assigneeAccountId: NullableString,
  previousAssigneeAccountId: NullableString,
  labels: StringList,
  addedLabels: StringList,
  removedLabels: StringList,
});
export type TriggerJiraEventPayload = typeof TriggerJiraEventPayload.Type;

export const TriggerJiraQueryEventType = Schema.Literals(TRIGGER_EVENT_TYPES.jira_query);
export type TriggerJiraQueryEventType = typeof TriggerJiraQueryEventType.Type;

export const TriggerJiraQueryEventPayload = Schema.Struct({
  ...TriggerJiraEventPayload.fields,
  type: TriggerJiraQueryEventType,
  changedFields: StringList,
  query: Schema.String,
});
export type TriggerJiraQueryEventPayload = typeof TriggerJiraQueryEventPayload.Type;

export const TriggerGitLabEventType = Schema.Literals(TRIGGER_EVENT_TYPES.gitlab);
export type TriggerGitLabEventType = typeof TriggerGitLabEventType.Type;

export const TriggerGitLabEventPayload = Schema.Struct({
  type: TriggerGitLabEventType,
  host: Schema.String,
  repository: Schema.String,
  number: Schema.String,
  url: Schema.String,
  title: Schema.String,
  state: Schema.String,
  previousState: NullableString,
  isDraft: Schema.Literals(["true", "false"]),
  headBranch: Schema.String,
  baseBranch: Schema.String,
  checksState: NullableString,
  previousChecksState: NullableString,
  reviewDecision: NullableString,
  author: NullableString,
});
export type TriggerGitLabEventPayload = typeof TriggerGitLabEventPayload.Type;

export const TriggerGitLabProjectsEventType = Schema.Literals(TRIGGER_EVENT_TYPES.gitlab_projects);
export type TriggerGitLabProjectsEventType = typeof TriggerGitLabProjectsEventType.Type;

/** A pipeline event fills the merge request fields from the merge request it ran for, if known. */
export const TriggerGitLabProjectsEventPayload = Schema.Struct({
  ...TriggerGitLabEventPayload.fields,
  type: TriggerGitLabProjectsEventType,
  pipelineId: NullableString,
  pipelineStatus: NullableString,
  pipelineUrl: NullableString,
  pipelineRef: NullableString,
});
export type TriggerGitLabProjectsEventPayload = typeof TriggerGitLabProjectsEventPayload.Type;

export const TriggerSlackEventPayload = Schema.Struct({
  type: Schema.Literal("message"),
  tenantId: Schema.String,
  surface: Schema.String,
  invocationId: Schema.String,
  prompt: Schema.String,
});
export type TriggerSlackEventPayload = typeof TriggerSlackEventPayload.Type;

export const TriggerManualEventPayload = Schema.Struct({ type: Schema.Literal("manual") });
export type TriggerManualEventPayload = typeof TriggerManualEventPayload.Type;

// Set on events only one trigger may run, such as a Jira query trigger's own poll results.
const triggerId = Schema.optional(ScheduledTaskId);

export const TriggerEvent = Schema.Union([
  Schema.Struct({
    source: Schema.Literal("jira"),
    type: TriggerJiraEventType,
    triggerId,
    occurredAt: IsoDateTime,
    payload: TriggerJiraEventPayload,
  }),
  Schema.Struct({
    source: Schema.Literal("jira_query"),
    type: TriggerJiraQueryEventType,
    triggerId,
    occurredAt: IsoDateTime,
    payload: TriggerJiraQueryEventPayload,
  }),
  Schema.Struct({
    source: Schema.Literal("gitlab"),
    type: TriggerGitLabEventType,
    triggerId,
    occurredAt: IsoDateTime,
    payload: TriggerGitLabEventPayload,
  }),
  Schema.Struct({
    source: Schema.Literal("gitlab_projects"),
    type: TriggerGitLabProjectsEventType,
    triggerId,
    occurredAt: IsoDateTime,
    payload: TriggerGitLabProjectsEventPayload,
  }),
  Schema.Struct({
    source: Schema.Literal("slack"),
    type: Schema.Literal("message"),
    triggerId,
    occurredAt: IsoDateTime,
    payload: TriggerSlackEventPayload,
  }),
  Schema.Struct({
    source: Schema.Literal("manual"),
    type: Schema.Literal("manual"),
    triggerId,
    occurredAt: IsoDateTime,
    payload: TriggerManualEventPayload,
  }),
]);
export type TriggerEvent = typeof TriggerEvent.Type;

export const TriggerThreadTarget = Schema.Struct({
  type: Schema.Literal("thread"),
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId).annotate({
    description: "Thread runs go to. null starts a new thread on the first run.",
  }),
  threadMode: ScheduledTaskThreadMode,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type TriggerThreadTarget = typeof TriggerThreadTarget.Type;

export const TriggerTarget = Schema.Union([TriggerThreadTarget, TriggerWorkItemTarget]);
export type TriggerTarget = typeof TriggerTarget.Type;

const {
  type: _webhookType,
  filters: _webhookFilters,
  ...webhookSourceFields
} = ScheduledTaskWebhookSchedule.fields;
const {
  type: _saveWebhookType,
  filters: _saveWebhookFilters,
  ...webhookSaveSourceFields
} = ScheduledTaskUpsertWebhookSchedule.fields;

const TriggerEventSourceKind = Schema.Literals(["jira", "gitlab", "slack", "manual"]);

const TriggerJiraQuerySource = Schema.Struct({
  kind: Schema.Literal("jira_query"),
  ...jiraQueryFields,
}).check(isOneJiraQuery);

const TriggerGitLabProjectsSource = Schema.Struct({
  kind: Schema.Literal("gitlab_projects"),
  ...gitlabProjectsFields,
}).check(hasGitLabProjects);

export const TriggerSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("schedule"), schedule: ScheduledTaskTimeSchedule }),
  Schema.Struct({ kind: Schema.Literal("webhook"), ...webhookSourceFields }),
  Schema.Struct({ kind: TriggerEventSourceKind }),
  TriggerJiraQuerySource,
  TriggerGitLabProjectsSource,
]);
export type TriggerSource = typeof TriggerSource.Type;

export const TriggerSaveSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("schedule"),
    schedule: ScheduledTaskUpsertTimeSchedule,
  }).annotate({ description: "Run on a clock." }),
  Schema.Struct({ kind: Schema.Literal("webhook"), ...webhookSaveSourceFields }).annotate({
    description: "Run per webhook request. Filters use body., headers., and query. paths.",
  }),
  Schema.Struct({ kind: TriggerEventSourceKind }).annotate({
    description: "Run on Jira, GitLab, or Slack events, filtered on event. paths, or only by hand.",
  }),
  TriggerJiraQuerySource.annotate({
    description: "Poll a JQL or saved filter as the site's service identity, per issue change.",
  }),
  TriggerGitLabProjectsSource.annotate({
    description: "Poll GitLab projects or a group for merge request and pipeline changes.",
  }),
]);
export type TriggerSaveSource = typeof TriggerSaveSource.Type;

// Webhook sources keep their body/headers/query filters.
const TriggerFilterList = Schema.Array(Schema.Union([TriggerFilter, ScheduledTaskWebhookFilter]))
  .check(Schema.isMaxLength(MAX_WEBHOOK_FILTERS))
  .annotate({ description: "All must match. Max 16." });

export const Trigger = Schema.Struct({
  id: ScheduledTaskId,
  title: ScheduledTask.fields.title,
  prompt: ScheduledTask.fields.prompt,
  enabled: Schema.Boolean,
  source: TriggerSource,
  filters: TriggerFilterList,
  target: TriggerTarget,
  triage: ScheduledTask.fields.triage,
  nextRunAt: ScheduledTask.fields.nextRunAt,
  lastRunAt: ScheduledTask.fields.lastRunAt,
  lastRunStatus: ScheduledTask.fields.lastRunStatus,
  lastRunError: ScheduledTask.fields.lastRunError,
  runCount: ScheduledTask.fields.runCount,
  webhook: ScheduledTask.fields.webhook,
  blockedByPolicy: ScheduledTask.fields.blockedByPolicy,
  createdBy: ScheduledTask.fields.createdBy,
  creationSource: ScheduledTask.fields.creationSource,
  createdAt: ScheduledTask.fields.createdAt,
  updatedAt: ScheduledTask.fields.updatedAt,
});
export type Trigger = typeof Trigger.Type;

const WEBHOOK_FILTER_PATH = /^(body|headers|query)(\.|$)/;
const EVENT_FILTER_PATH = /^event\./;

function filtersFitSource(input: {
  readonly source: TriggerSaveSource;
  readonly filters: ReadonlyArray<{ readonly path: string }>;
}) {
  const { kind } = input.source;
  if (kind === "schedule" || kind === "manual") {
    return input.filters.length === 0 || `A ${kind} trigger takes no filters.`;
  }
  const pattern = kind === "webhook" ? WEBHOOK_FILTER_PATH : EVENT_FILTER_PATH;
  return (
    input.filters.every((filter) => pattern.test(filter.path)) ||
    (kind === "webhook"
      ? "Webhook filters use body., headers., or query. paths."
      : `${kind} filters use event. paths.`)
  );
}

export const TriggerSaveInput = Schema.Struct({
  id: Schema.optional(ScheduledTaskId).annotate({ description: "Omit to create a trigger." }),
  requireExisting: ScheduledTaskUpsertInput.fields.requireExisting,
  commandId: Schema.optional(CommandId),
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString.annotate({
    description: "Event sources can use {{event.field}} and {{event}}; webhooks {{body.path}}.",
  }),
  enabled: Schema.Boolean,
  source: TriggerSaveSource,
  filters: TriggerFilterList,
  target: TriggerTarget,
  triage: ScheduledTaskUpsertInput.fields.triage,
}).check(Schema.makeFilter(filtersFitSource));
export type TriggerSaveInput = typeof TriggerSaveInput.Type;

export const TriggerListInput = Schema.Struct({});
export type TriggerListInput = typeof TriggerListInput.Type;

export const TriggerListResult = Schema.Struct({ triggers: ForwardCompatibleArray(Trigger) });
export type TriggerListResult = typeof TriggerListResult.Type;

export const TriggerMutationResult = Schema.Struct({ trigger: Trigger });
export type TriggerMutationResult = typeof TriggerMutationResult.Type;

/** The one mapping from a stored scheduled task to the trigger clients and agents see. */
export function scheduledTaskTrigger(task: ScheduledTask): Trigger {
  const {
    schedule,
    projectId,
    threadId,
    threadMode: _threadMode,
    workspaceStrategy,
    modelSelection,
    runtimeMode,
    interactionMode,
    target,
    ...fields
  } = task;
  let source: TriggerSource;
  if (schedule.type === "interval" || schedule.type === "fixed_time" || schedule.type === "once") {
    source = { kind: "schedule", schedule };
  } else if (schedule.type === "webhook") {
    const { type: _type, filters: _filters, ...webhook } = schedule;
    source = { kind: "webhook", ...webhook };
  } else if (schedule.type === "jira_query") {
    const { type: _type, filters: _filters, ...query } = schedule;
    source = { kind: "jira_query", ...query };
  } else if (schedule.type === "gitlab_projects") {
    const { type: _type, filters: _filters, ...projects } = schedule;
    source = { kind: "gitlab_projects", ...projects };
  } else {
    source = { kind: schedule.type };
  }
  return {
    ...fields,
    source,
    filters: "filters" in schedule ? (schedule.filters ?? []) : [],
    target: target ?? {
      type: "thread",
      projectId,
      threadId,
      threadMode: scheduledTaskThreadMode(task),
      workspaceStrategy,
      modelSelection,
      runtimeMode,
      interactionMode,
    },
  };
}

// A work item trigger's thread columns are unused; the server keeps a stored task's.
const workItemThreadDefaults = {
  threadId: null,
  threadMode: "new_thread",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL },
  runtimeMode: DEFAULT_RUNTIME_MODE,
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
} as const satisfies Omit<TriggerThreadTarget, "type" | "projectId">;

/** The inverse of `scheduledTaskTrigger` for saves: the source holds the filters again. */
export function triggerUpsertToScheduledTaskUpsert(
  input: TriggerSaveInput,
): ScheduledTaskUpsertInput {
  const { source, filters } = input;
  let schedule: ScheduledTaskUpsertSchedule;
  if (source.kind === "schedule") {
    schedule = source.schedule;
  } else if (source.kind === "webhook") {
    const { kind: _kind, ...webhook } = source;
    schedule = { type: "webhook", ...webhook, filters };
  } else if (source.kind === "manual") {
    schedule = { type: "manual" };
  } else if (source.kind === "jira_query") {
    const { kind: _kind, ...query } = source;
    schedule = { type: "jira_query", ...query, filters };
  } else if (source.kind === "gitlab_projects") {
    const { kind: _kind, ...projects } = source;
    schedule = { type: "gitlab_projects", ...projects, filters };
  } else {
    schedule = { type: source.kind, filters };
  }
  const { target } = input;
  let binding: Omit<TriggerThreadTarget, "type"> & {
    readonly target: TriggerWorkItemTarget | null;
  };
  if (target.type === "work_item") {
    binding = { projectId: target.projectId, ...workItemThreadDefaults, target };
  } else {
    const { type: _type, ...thread } = target;
    binding = { ...thread, target: null };
  }
  return {
    ...(input.id === undefined ? {} : { id: input.id }),
    ...(input.requireExisting === undefined ? {} : { requireExisting: input.requireExisting }),
    ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
    title: input.title,
    prompt: input.prompt,
    enabled: input.enabled,
    schedule,
    ...binding,
    ...(input.triage === undefined ? {} : { triage: input.triage }),
  };
}

export const TriggerTemplateName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/),
).annotate({ description: "File name without .md: lowercase letters, digits, and dashes." });
export type TriggerTemplateName = typeof TriggerTemplateName.Type;

// These names are filled at run time, so a template placeholder must not shadow them.
const RUNTIME_PLACEHOLDER_NAMES = new Set(["event", "body", "headers", "query", "request"]);

export const TriggerTemplatePlaceholder = Schema.Struct({
  name: Schema.String.check(
    Schema.isPattern(/^[a-z][a-zA-Z0-9_]*$/),
    Schema.makeFilter(
      (name) => !RUNTIME_PLACEHOLDER_NAMES.has(name) || `${name} is filled when the trigger runs.`,
    ),
  ),
  description: Schema.optional(Schema.String),
  default: Schema.optional(Schema.String),
});
export type TriggerTemplatePlaceholder = typeof TriggerTemplatePlaceholder.Type;

/** Any path, since webhook templates use `body.` paths; values may hold `{{placeholder}}`. */
export const TriggerTemplateFilter = makeFilterSchema(TrimmedNonEmptyString);
export type TriggerTemplateFilter = typeof TriggerTemplateFilter.Type;

export const TriggerTemplate = Schema.Struct({
  name: TriggerTemplateName,
  title: TrimmedNonEmptyString,
  source: TriggerSourceKind,
  filters: Schema.Array(TriggerTemplateFilter).check(Schema.isMaxLength(MAX_WEBHOOK_FILTERS)),
  prompt: Schema.String,
  placeholders: Schema.Array(TriggerTemplatePlaceholder),
});
export type TriggerTemplate = typeof TriggerTemplate.Type;

export const TriggerTemplateListInput = Schema.Struct({ projectId: ProjectId });
export type TriggerTemplateListInput = typeof TriggerTemplateListInput.Type;

export const TriggerTemplateListResult = Schema.Struct({
  templates: ForwardCompatibleArray(TriggerTemplate),
});
export type TriggerTemplateListResult = typeof TriggerTemplateListResult.Type;

export const TriggerTemplateSaveInput = Schema.Struct({
  projectId: ProjectId,
  template: TriggerTemplate,
});
export type TriggerTemplateSaveInput = typeof TriggerTemplateSaveInput.Type;

export const TriggerTemplateSaveResult = Schema.Struct({ template: TriggerTemplate });
export type TriggerTemplateSaveResult = typeof TriggerTemplateSaveResult.Type;

export const TriggerTemplateDeleteInput = Schema.Struct({
  projectId: ProjectId,
  name: TriggerTemplateName,
});
export type TriggerTemplateDeleteInput = typeof TriggerTemplateDeleteInput.Type;

export const TriggerTemplateDeleteResult = Schema.Struct({ name: TriggerTemplateName });
export type TriggerTemplateDeleteResult = typeof TriggerTemplateDeleteResult.Type;

// `templateName`, not `name`: an error's own `name` is its class name.
export class TriggerTemplateError extends Schema.TaggedError<TriggerTemplateError>()(
  "TriggerTemplateError",
  {
    message: Schema.String,
    templateName: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const TEMPLATE_PLACEHOLDER = /\{\{\s*([a-z][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Fills the template's declared placeholders from `values`, then their defaults. Blank values
 * count as unset. Undeclared placeholders, such as `{{event.key}}`, stay for run time.
 */
export function fillTriggerTemplate(
  template: Pick<TriggerTemplate, "filters" | "prompt" | "placeholders">,
  values: Readonly<Record<string, string>>,
) {
  const filled = new Map<string, string>();
  const missing: string[] = [];
  for (const placeholder of template.placeholders) {
    const value = values[placeholder.name];
    const resolved = value !== undefined && value.trim() !== "" ? value : placeholder.default;
    if (resolved === undefined) missing.push(placeholder.name);
    else filled.set(placeholder.name, resolved);
  }
  const fill = (text: string) =>
    text.replace(TEMPLATE_PLACEHOLDER, (match, name: string) => filled.get(name) ?? match);
  const filters = template.filters.map((filter): TriggerTemplateFilter => {
    if (filter.op === "exists") return filter;
    if (filter.op === "in") return { ...filter, value: filter.value.map(fill) };
    return { ...filter, value: fill(filter.value) };
  });
  return { filters, prompt: fill(template.prompt), missing };
}

export const TriggerRaiseInput = Schema.Struct({ event: TriggerEvent });
export type TriggerRaiseInput = typeof TriggerRaiseInput.Type;

export const TriggerRaiseResult = Schema.Struct({ matched: NonNegativeInt });
export type TriggerRaiseResult = typeof TriggerRaiseResult.Type;
