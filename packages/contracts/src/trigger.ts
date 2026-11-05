import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2ThreadLaunchWorkspaceStrategy } from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import {
  MAX_WEBHOOK_FILTERS,
  makeFilterSchema,
  ScheduledTaskTimeSchedule,
  ScheduledTaskWebhookFilter,
  TriggerFilter,
  type ScheduledTask,
} from "./scheduledTask.ts";

export const TriggerSourceKind = Schema.Literals([
  "schedule",
  "webhook",
  "slack",
  "jira",
  "gitlab",
  "manual",
]);
export type TriggerSourceKind = typeof TriggerSourceKind.Type;

/** Sources that raise events with fields a filter can select on. */
export const TriggerFilterSourceKind = Schema.Literals(["jira", "gitlab", "slack"]);
export type TriggerFilterSourceKind = typeof TriggerFilterSourceKind.Type;

const TRIGGER_EVENT_TYPES = {
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
} as const;

export interface TriggerSourceField {
  readonly path: `event.${string}`;
  readonly label: string;
  readonly description: string;
  readonly array?: true;
}

export const TRIGGER_SOURCE_FIELDS = {
  jira: [
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
  ],
  gitlab: [
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

export const TriggerEvent = Schema.Union([
  Schema.Struct({
    source: Schema.Literal("jira"),
    type: TriggerJiraEventType,
    occurredAt: IsoDateTime,
    payload: TriggerJiraEventPayload,
  }),
  Schema.Struct({
    source: Schema.Literal("gitlab"),
    type: TriggerGitLabEventType,
    occurredAt: IsoDateTime,
    payload: TriggerGitLabEventPayload,
  }),
  Schema.Struct({
    source: Schema.Literal("slack"),
    type: Schema.Literal("message"),
    occurredAt: IsoDateTime,
    payload: TriggerSlackEventPayload,
  }),
  Schema.Struct({
    source: Schema.Literal("manual"),
    type: Schema.Literal("manual"),
    occurredAt: IsoDateTime,
    payload: TriggerManualEventPayload,
  }),
]);
export type TriggerEvent = typeof TriggerEvent.Type;

export const TriggerThreadTarget = Schema.Struct({
  type: Schema.Literal("thread"),
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type TriggerThreadTarget = typeof TriggerThreadTarget.Type;

/** One member until factories add theirs. */
export const TriggerTarget = Schema.Union([TriggerThreadTarget]);
export type TriggerTarget = typeof TriggerTarget.Type;

export const TriggerSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("schedule"), schedule: ScheduledTaskTimeSchedule }),
  Schema.Struct({ kind: Schema.Literal("webhook") }),
  Schema.Struct({ kind: Schema.Literals(["jira", "gitlab", "slack", "manual"]) }),
]);
export type TriggerSource = typeof TriggerSource.Type;

export const Trigger = Schema.Struct({
  source: TriggerSource,
  // Webhook sources keep their body/headers/query filters.
  filters: Schema.Array(Schema.Union([TriggerFilter, ScheduledTaskWebhookFilter])).check(
    Schema.isMaxLength(MAX_WEBHOOK_FILTERS),
  ),
  target: TriggerTarget,
});
export type Trigger = typeof Trigger.Type;

export function scheduledTaskTrigger(task: ScheduledTask): Trigger {
  const { schedule } = task;
  const source: TriggerSource =
    schedule.type === "interval" || schedule.type === "fixed_time" || schedule.type === "once"
      ? { kind: "schedule", schedule }
      : { kind: schedule.type };
  return {
    source,
    filters: "filters" in schedule ? (schedule.filters ?? []) : [],
    target: {
      type: "thread",
      projectId: task.projectId,
      threadId: task.threadId,
      workspaceStrategy: task.workspaceStrategy,
      modelSelection: task.modelSelection,
      runtimeMode: task.runtimeMode,
      interactionMode: task.interactionMode,
    },
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
