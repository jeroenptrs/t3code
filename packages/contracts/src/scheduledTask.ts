import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  CommandId,
  FactoryId,
  ForwardCompatibleArray,
  IsoDateTime,
  ProjectId,
  ScheduledTaskId,
  SecretRef,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { AuthUserReference } from "./authUser.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

const TimeOfDay = TrimmedNonEmptyString.check(
  Schema.isPattern(/^([01]?\d|2[0-3]):([0-5]\d)$/),
).annotate({ description: "Local time as HH:MM, such as 09:30." });

const ScheduledTaskTimeZone = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      Option.isSome(DateTime.zoneMakeNamed(value)) || "timeZone must be an IANA time zone name.",
  ),
).annotate({
  description:
    "IANA time zone the wall-clock time is read in, such as Europe/Amsterdam. Omit to use the server's local time zone.",
});

export const MIN_SCHEDULED_TASK_INTERVAL_MS = 60_000;

const ScheduledTaskIntervalMs = Schema.Int.check(Schema.isGreaterThan(0));

const ScheduledTaskIntervalSchedule = Schema.Struct({
  type: Schema.Literal("interval"),
  everyMs: ScheduledTaskIntervalMs,
});

const ScheduledTaskFixedTimeSchedule = Schema.Struct({
  type: Schema.Literal("fixed_time"),
  timeOfDay: TimeOfDay,
  timeZone: Schema.optional(ScheduledTaskTimeZone),
  weekdays: Schema.optional(
    Schema.Array(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })).annotate({
        description: "Weekday. 0 is Sunday, 6 is Saturday.",
      }),
    ).annotate({
      description: "Default: every day.",
    }),
  ),
});

const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const YEAR_0000 = Date.parse("0000-01-01T00:00:00Z");
const YEAR_10000 = Date.parse("+010000-01-01T00:00:00Z");

/** Date.parse rolls impossible days like Feb 30 into the next month, so check the day too. */
function isIsoWithOffset(value: string): boolean {
  const match = ISO_WITH_OFFSET.exec(value);
  // The server stores UTC, which must stay a four-digit year to decode again.
  const time = Date.parse(value);
  if (!match || !(time >= YEAR_0000 && time < YEAR_10000)) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return days !== undefined && day >= 1 && day <= days;
}

// Checked by filter, not pattern, to keep the MCP tool schema small.
const ScheduledTaskOnceSchedule = Schema.Struct({
  type: Schema.Literal("once"),
  runAt: TrimmedNonEmptyString.check(
    Schema.makeFilter(
      (value) => isIsoWithOffset(value) || "Expected an ISO date and time with an offset.",
    ),
  ),
});

const ScheduledTaskWebhookSignatureFields = {
  header: TrimmedNonEmptyString.annotate({
    description: "Header with the signature, such as x-hub-signature-256.",
  }),
  encoding: Schema.Literals(["hex", "base64"]),
  prefix: Schema.String.annotate({
    description: "Text before the digest, such as 'sha256='. Empty for none.",
  }),
};

export const ScheduledTaskWebhookSignature = Schema.Struct(
  ScheduledTaskWebhookSignatureFields,
).annotate({ description: "HMAC-SHA256 check on the raw body." });
export type ScheduledTaskWebhookSignature = typeof ScheduledTaskWebhookSignature.Type;

/** Matches how long the relay holds a request for an offline environment. */
export const MAX_WEBHOOK_DELIVERY_AGE_MINUTES = 24 * 60;

const WebhookMaxDeliveryAgeMinutes = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_WEBHOOK_DELIVERY_AGE_MINUTES }),
).annotate({
  description: "Skip requests held offline over this many minutes. Omit to run all.",
});

export function isWebhookDedupeTemplate(template: string): boolean {
  const placeholders = /\{\{\s*(?:(?:body|headers|query)(?:\.[^{}.\s]+)*|request)\s*\}\}/g;
  const matches = [...template.matchAll(placeholders)];
  const remainder = template.replace(placeholders, "");
  return matches.length > 0 && !remainder.includes("{{") && !remainder.includes("}}");
}

const WebhookDedupeTemplate = Schema.String.check(Schema.makeFilter(isWebhookDedupeTemplate));

const ScheduledTaskWebhookDedupe = Schema.Struct({
  replayKey: Schema.optional(WebhookDedupeTemplate),
  coalesceKey: Schema.optional(WebhookDedupeTemplate),
  coalesceWindowSeconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 3600 })),
  ),
}).annotate({
  description: "Replay and coalesce key templates. Window in seconds, default 120.",
});

export const MAX_WEBHOOK_FILTERS = 16;

const WebhookFilterPath = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(body|headers|query)(\.|$)/),
);

/**
 * Forms edit an `in` list as comma-separated text, so a value that has no
 * comma and no surrounding whitespace survives that round trip unchanged.
 */
const WebhookFilterListValue = Schema.String.check(
  Schema.isPattern(/^[^,\s](?:[^,]*[^,\s])?$/),
).annotate({ description: "Non-empty, without commas or surrounding whitespace." });

/** One filter's operator and value shapes, shared by webhook, trigger, and template filters. */
export const makeFilterSchema = (path: typeof TrimmedNonEmptyString) =>
  Schema.Union([
    Schema.Struct({
      path,
      op: Schema.Literals(["equals", "notEquals", "startsWith"]),
      value: Schema.String,
    }),
    Schema.Struct({
      path,
      op: Schema.Literal("in"),
      value: Schema.Array(WebhookFilterListValue).check(Schema.isMinLength(1)),
    }),
    Schema.Struct({ path, op: Schema.Literal("exists") }),
  ]);

export const ScheduledTaskWebhookFilter = makeFilterSchema(WebhookFilterPath).annotate({
  description:
    "Path: `headers.x-event` or `body.action`. String compare. Objects pass only 'exists'. A `[]` segment matches any array item. `notEquals` passes only if no item equals.",
});
export type ScheduledTaskWebhookFilter = typeof ScheduledTaskWebhookFilter.Type;
export type ScheduledTaskWebhookFilterOp = ScheduledTaskWebhookFilter["op"];

const ScheduledTaskWebhookFilters = Schema.Array(ScheduledTaskWebhookFilter)
  .check(Schema.isMaxLength(MAX_WEBHOOK_FILTERS))
  .annotate({
    description: "All must match. Max 16. Omitted: keep stored. [] clears.",
  });

export const ScheduledTaskWebhookSchedule = Schema.Struct({
  type: Schema.Literal("webhook"),
  signature: Schema.NullOr(ScheduledTaskWebhookSignature),
  maxDeliveryAgeMinutes: Schema.optional(Schema.NullOr(WebhookMaxDeliveryAgeMinutes)),
  dedupe: Schema.optional(ScheduledTaskWebhookDedupe),
  filters: Schema.optional(ScheduledTaskWebhookFilters),
}).annotate({
  description: "Run on each webhook request.",
});

export const ScheduledTaskUpsertWebhookSchedule = Schema.Struct({
  type: Schema.Literal("webhook"),
  signature: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        ...ScheduledTaskWebhookSignatureFields,
        secret: Schema.optional(TrimmedNonEmptyString).annotate({
          description: "Default: stored secret.",
        }),
        secretRef: Schema.optional(SecretRef).annotate({
          description: "From `request_secret`. Instead of `secret`. Spent by this save.",
        }),
      }),
    ),
  ).annotate({
    description: "Omit for URL token only.",
  }),
  maxDeliveryAgeMinutes: Schema.optional(Schema.NullOr(WebhookMaxDeliveryAgeMinutes)),
  dedupe: Schema.optional(ScheduledTaskWebhookDedupe),
  filters: Schema.optional(ScheduledTaskWebhookFilters),
}).annotate({
  description:
    "Run per webhook request. Prompt can use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}}, {{request}}.",
});

export const TriggerFilterPath = TrimmedNonEmptyString.check(
  Schema.isPattern(/^event\.[a-zA-Z][a-zA-Z0-9]*$/),
).annotate({ description: "An event field, such as `event.status`." });

export const TriggerFilter = makeFilterSchema(TriggerFilterPath).annotate({
  description:
    "String compare on one event field. Array fields match when any item does; `notEquals` passes only if no item equals, `exists` only if non-empty. Null fields fail every op.",
});
export type TriggerFilter = typeof TriggerFilter.Type;
export type TriggerFilterOp = TriggerFilter["op"];

export const TriggerFilters = Schema.Array(TriggerFilter)
  .check(Schema.isMaxLength(MAX_WEBHOOK_FILTERS))
  .annotate({
    description: "All must match. Max 16. Omitted: keep stored. [] clears.",
  });
export type TriggerFilters = typeof TriggerFilters.Type;

export const ScheduledTaskJiraSchedule = Schema.Struct({
  type: Schema.Literal("jira"),
  filters: Schema.optional(TriggerFilters),
}).annotate({
  description: "Run on Jira issue changes. Prompt can use {{event.field}} and {{event}}.",
});

export const ScheduledTaskGitLabSchedule = Schema.Struct({
  type: Schema.Literal("gitlab"),
  filters: Schema.optional(TriggerFilters),
}).annotate({
  description: "Run on GitLab merge request changes. Prompt can use {{event.field}} and {{event}}.",
});

export const ScheduledTaskSlackSchedule = Schema.Struct({
  type: Schema.Literal("slack"),
  filters: Schema.optional(TriggerFilters),
}).annotate({
  description: "Run on Slack messages. Prompt can use {{event.field}} and {{event}}.",
});

export const MIN_POLL_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_POLL_INTERVAL_MS = 15 * 60_000;

/**
 * What a polled trigger's first poll raises: nothing (`changes`), or the current set as entered
 * issues or opened merge requests (`current`). Unset is `changes`.
 */
export const PollTriggerStart = Schema.Literals(["changes", "current"]);
export type PollTriggerStart = typeof PollTriggerStart.Type;

/** A Jira query names exactly one of a JQL string and a saved filter. */
export const jiraQueryFields = {
  site: TrimmedNonEmptyString.annotate({ description: "Jira site, such as acme.atlassian.net." }),
  jql: Schema.optional(TrimmedNonEmptyString),
  filterId: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "Saved filter id, instead of jql.",
  }),
  everyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_POLL_INTERVAL_MS)).annotate({
    description: "Poll interval. Min 300000.",
  }),
  start: Schema.optional(PollTriggerStart),
};

export const isOneJiraQuery = Schema.makeFilter(
  (query: { readonly jql?: string | undefined; readonly filterId?: string | undefined }) =>
    (query.jql === undefined) !== (query.filterId === undefined) || "Set either jql or filterId.",
);

export const ScheduledTaskJiraQuerySchedule = Schema.Struct({
  type: Schema.Literal("jira_query"),
  ...jiraQueryFields,
  filters: Schema.optional(TriggerFilters),
})
  .check(isOneJiraQuery)
  .annotate({
    description:
      "Poll a Jira query as the site's service identity. Prompt can use {{event.field}} and {{event}}.",
  });
export type ScheduledTaskJiraQuerySchedule = typeof ScheduledTaskJiraQuerySchedule.Type;

/** GitLab projects polled for merge requests and pipelines: project paths, a group, or both. */
export const gitlabProjectsFields = {
  host: TrimmedNonEmptyString.annotate({ description: "GitLab host, such as gitlab.com." }),
  projects: Schema.Array(TrimmedNonEmptyString).annotate({
    description: "Project paths, such as acme/app.",
  }),
  group: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "Group path, such as acme. Its projects' merge requests are polled.",
  }),
  everyMs: jiraQueryFields.everyMs,
  start: jiraQueryFields.start,
};

export const hasGitLabProjects = Schema.makeFilter(
  (source: { readonly projects: ReadonlyArray<string>; readonly group?: string | undefined }) =>
    source.projects.length > 0 || source.group !== undefined || "Name a project or a group.",
);

export const ScheduledTaskGitLabProjectsSchedule = Schema.Struct({
  type: Schema.Literal("gitlab_projects"),
  ...gitlabProjectsFields,
  filters: Schema.optional(TriggerFilters),
})
  .check(hasGitLabProjects)
  .annotate({
    description:
      "Poll GitLab projects as the host's glab login. Prompt can use {{event.field}} and {{event}}.",
  });
export type ScheduledTaskGitLabProjectsSchedule = typeof ScheduledTaskGitLabProjectsSchedule.Type;

export const ScheduledTaskManualSchedule = Schema.Struct({
  type: Schema.Literal("manual"),
}).annotate({ description: "Run only when started by hand." });

/** The clock-driven schedules, which the scheduler runs. */
export const ScheduledTaskTimeSchedule = Schema.Union([
  ScheduledTaskIntervalSchedule,
  ScheduledTaskFixedTimeSchedule,
  ScheduledTaskOnceSchedule,
]);
export type ScheduledTaskTimeSchedule = typeof ScheduledTaskTimeSchedule.Type;

/** Accept legacy sub-minute schedules so users can still manage them. */
export const ScheduledTaskSchedule = Schema.Union([
  ScheduledTaskIntervalSchedule,
  ScheduledTaskFixedTimeSchedule,
  ScheduledTaskOnceSchedule,
  ScheduledTaskWebhookSchedule,
  ScheduledTaskJiraSchedule,
  ScheduledTaskGitLabSchedule,
  ScheduledTaskSlackSchedule,
  ScheduledTaskManualSchedule,
  ScheduledTaskJiraQuerySchedule,
  ScheduledTaskGitLabProjectsSchedule,
]);
export type ScheduledTaskSchedule = typeof ScheduledTaskSchedule.Type;

/** The clock-driven schedules a save accepts: intervals of at least a minute. */
export const ScheduledTaskUpsertTimeSchedule = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("interval"),
    everyMs: ScheduledTaskIntervalMs.check(
      Schema.isGreaterThanOrEqualTo(MIN_SCHEDULED_TASK_INTERVAL_MS),
    ).annotate({
      description: "Min 60000.",
    }),
  }),
  ScheduledTaskFixedTimeSchedule,
  ScheduledTaskOnceSchedule,
]);

/** The kinds an agent sets over MCP. Event sources are set up in Settings, with their filters. */
export const ScheduledTaskUpsertAgentSchedule = Schema.Union([
  ...ScheduledTaskUpsertTimeSchedule.members,
  ScheduledTaskUpsertWebhookSchedule,
]);
export type ScheduledTaskUpsertAgentSchedule = typeof ScheduledTaskUpsertAgentSchedule.Type;

export const ScheduledTaskUpsertSchedule = Schema.Union([
  ...ScheduledTaskUpsertAgentSchedule.members,
  ScheduledTaskJiraSchedule,
  ScheduledTaskGitLabSchedule,
  ScheduledTaskSlackSchedule,
  ScheduledTaskManualSchedule,
  ScheduledTaskJiraQuerySchedule,
  ScheduledTaskGitLabProjectsSchedule,
]);
export type ScheduledTaskUpsertSchedule = typeof ScheduledTaskUpsertSchedule.Type;

export const ScheduledTaskTriage = Schema.Struct({
  fallback: Schema.Literals(["ask", "label", "stop"]),
  label: Schema.optional(TrimmedNonEmptyString),
})
  .check(
    Schema.makeFilter(
      (triage) =>
        triage.fallback !== "label" ||
        triage.label !== undefined ||
        "A triage label is required when the fallback is to add a label.",
    ),
  )
  .annotate({
    description:
      "Append triage instructions to every run. `fallback` is what the agent does with an item no instruction covers. `label` is required for `label`.",
  });
export type ScheduledTaskTriage = typeof ScheduledTaskTriage.Type;

export const ScheduledTaskRunStatus = Schema.Literals(["never", "running", "succeeded", "failed"]);
export type ScheduledTaskRunStatus = typeof ScheduledTaskRunStatus.Type;

export const ScheduledTaskWebhookEndpoint = Schema.Struct({
  path: TrimmedNonEmptyString,
  url: Schema.NullOr(TrimmedNonEmptyString),
  hasSecret: Schema.Boolean,
  /** Portal user who created the task; absent when it was not created from a user session. */
  createdByUser: Schema.optionalKey(AuthUserReference),
  /** When the URL token was last rotated; absent until the first rotation. */
  tokenRotatedAt: Schema.optionalKey(IsoDateTime),
  /** Portal user who last rotated the token; absent when that session had no user. */
  tokenRotatedByUser: Schema.optionalKey(AuthUserReference),
});
export type ScheduledTaskWebhookEndpoint = typeof ScheduledTaskWebhookEndpoint.Type;

/**
 * Where runs go. One-thread modes launch their thread on the first run and keep it; `fresh_session`
 * starts each later run in a new provider session there.
 */
export const ScheduledTaskThreadMode = Schema.Literals(["new_thread", "continue", "fresh_session"]);
export type ScheduledTaskThreadMode = typeof ScheduledTaskThreadMode.Type;

/** Servers before thread modes omit it; their bound tasks continue the conversation. */
export function scheduledTaskThreadMode(
  task: Pick<ScheduledTask, "threadId" | "threadMode">,
): ScheduledTaskThreadMode {
  return task.threadMode ?? (task.threadId === null ? "new_thread" : "continue");
}

/**
 * A trigger that creates a work item in a factory of `projectId` instead of running its prompt in
 * a thread. A task with it keeps the thread columns, which the Foreman's role binding overrides.
 */
export const TriggerWorkItemTarget = Schema.Struct({
  type: Schema.Literal("work_item"),
  projectId: ProjectId.annotate({ description: "The factory's project." }),
  factoryId: FactoryId,
});
export type TriggerWorkItemTarget = typeof TriggerWorkItemTarget.Type;

export const ScheduledTask = Schema.Struct({
  id: ScheduledTaskId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskSchedule,
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  threadMode: Schema.optional(ScheduledTaskThreadMode),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  lastRunError: Schema.NullOr(Schema.String),
  runCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  webhook: Schema.optional(ScheduledTaskWebhookEndpoint),
  /** Why the task cannot run regardless of `enabled`, such as a managed policy refusing webhooks. */
  blockedByPolicy: Schema.optionalKey(Schema.String),
  triage: Schema.optionalKey(ScheduledTaskTriage),
  /** Absent: runs go to the thread the fields above describe. */
  target: Schema.optionalKey(TriggerWorkItemTarget),
});
export type ScheduledTask = typeof ScheduledTask.Type;

export const ScheduledTaskListInput = Schema.Struct({});
export type ScheduledTaskListInput = typeof ScheduledTaskListInput.Type;

export const ScheduledTaskListResult = Schema.Struct({
  tasks: ForwardCompatibleArray(ScheduledTask),
  /** The server's IANA zone for fixed-time schedules. Absent from older servers. */
  timeZone: Schema.optional(TrimmedNonEmptyString),
});
export type ScheduledTaskListResult = typeof ScheduledTaskListResult.Type;

export const ScheduledTaskUpsertInput = Schema.Struct({
  id: Schema.optional(ScheduledTaskId),
  requireExisting: Schema.optional(Schema.Boolean).annotate({
    description: "Reject the save if the task no longer exists, for edits from a client form.",
  }),
  commandId: Schema.optional(CommandId),
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskUpsertSchedule,
  projectId: ProjectId,
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  /** Omitted: keep the stored mode, or derive it from `threadId` for a new or rebound task. */
  threadMode: Schema.optional(ScheduledTaskThreadMode),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdBy: Schema.optional(OrchestrationV2Actor),
  creationSource: Schema.optional(OrchestrationV2CreationSource),
  triage: Schema.optional(Schema.NullOr(ScheduledTaskTriage)).annotate({
    description: "Omitted: keep stored. null clears.",
  }),
  /** Omitted: keep stored. null: runs go to the thread the fields above describe. */
  target: Schema.optional(Schema.NullOr(TriggerWorkItemTarget)),
});
export type ScheduledTaskUpsertInput = typeof ScheduledTaskUpsertInput.Type;

export const ScheduledTaskSetEnabledInput = Schema.Struct({
  id: ScheduledTaskId,
  enabled: Schema.Boolean,
});
export type ScheduledTaskSetEnabledInput = typeof ScheduledTaskSetEnabledInput.Type;

export const ScheduledTaskDeleteInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskDeleteInput = typeof ScheduledTaskDeleteInput.Type;

export const ScheduledTaskRunNowInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskRunNowInput = typeof ScheduledTaskRunNowInput.Type;

export const ScheduledTaskRotateWebhookTokenInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskRotateWebhookTokenInput = typeof ScheduledTaskRotateWebhookTokenInput.Type;

export const ScheduledTaskWebhookDeliveryId = TrimmedNonEmptyString.pipe(
  Schema.brand("ScheduledTaskWebhookDeliveryId"),
);
export type ScheduledTaskWebhookDeliveryId = typeof ScheduledTaskWebhookDeliveryId.Type;

export const ScheduledTaskWebhookDeliveryOutcome = Schema.Literals([
  "accepted",
  "dispatch_failed",
  "duplicate",
  "coalesced",
  "rejected_signature",
  "disabled",
  "rate_limited",
  "expired",
  "filtered",
]);
export type ScheduledTaskWebhookDeliveryOutcome = typeof ScheduledTaskWebhookDeliveryOutcome.Type;

export const ScheduledTaskWebhookDeliverySummary = Schema.Struct({
  id: ScheduledTaskWebhookDeliveryId,
  taskId: ScheduledTaskId,
  receivedAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  contentType: Schema.NullOr(Schema.String),
  bodyBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  // Any string, so an outcome added later doesn't break a client's whole list.
  outcome: Schema.Union([ScheduledTaskWebhookDeliveryOutcome, Schema.String]),
  signatureVerified: Schema.Boolean,
  pendingWindow: Schema.optional(Schema.Boolean),
  missingFields: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type ScheduledTaskWebhookDeliverySummary = typeof ScheduledTaskWebhookDeliverySummary.Type;

export const ScheduledTaskWebhookDelivery = Schema.Struct({
  ...ScheduledTaskWebhookDeliverySummary.fields,
  query: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
  bodyTruncated: Schema.Boolean,
  renderedPrompt: Schema.NullOr(Schema.String),
});
export type ScheduledTaskWebhookDelivery = typeof ScheduledTaskWebhookDelivery.Type;

export const ScheduledTaskListWebhookDeliveriesInput = Schema.Struct({
  id: ScheduledTaskId,
  /**
   * Sent by clients that decode any outcome. Shipped clients decode a closed
   * list and fail on the whole response, so without it the server leaves out
   * rows with outcomes they don't know.
   */
  acceptAnyOutcome: Schema.optional(Schema.Boolean),
});
export type ScheduledTaskListWebhookDeliveriesInput =
  typeof ScheduledTaskListWebhookDeliveriesInput.Type;

export const ScheduledTaskListWebhookDeliveriesResult = Schema.Struct({
  deliveries: Schema.Array(ScheduledTaskWebhookDeliverySummary),
});
export type ScheduledTaskListWebhookDeliveriesResult =
  typeof ScheduledTaskListWebhookDeliveriesResult.Type;

export const ScheduledTaskGetWebhookDeliveryInput = Schema.Struct({
  id: ScheduledTaskId,
  deliveryId: ScheduledTaskWebhookDeliveryId,
  acceptAnyOutcome: Schema.optional(Schema.Boolean),
});
export type ScheduledTaskGetWebhookDeliveryInput = typeof ScheduledTaskGetWebhookDeliveryInput.Type;

export const ScheduledTaskGetWebhookDeliveryResult = Schema.Struct({
  delivery: ScheduledTaskWebhookDelivery,
});
export type ScheduledTaskGetWebhookDeliveryResult =
  typeof ScheduledTaskGetWebhookDeliveryResult.Type;

export const ScheduledTaskMutationResult = Schema.Struct({
  task: ScheduledTask,
});
export type ScheduledTaskMutationResult = typeof ScheduledTaskMutationResult.Type;

export const ScheduledTaskDeleteResult = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskDeleteResult = typeof ScheduledTaskDeleteResult.Type;

export const ScheduledTaskRunNowResult = Schema.Struct({
  task: ScheduledTask,
});
export type ScheduledTaskRunNowResult = typeof ScheduledTaskRunNowResult.Type;

export class ScheduledTaskError extends Schema.TaggedError<ScheduledTaskError>()(
  "ScheduledTaskError",
  {
    message: Schema.String,
    taskId: Schema.optional(ScheduledTaskId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
