import type { ScheduledTask, ScheduledTaskError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * What a due polled trigger (a Jira query or GitLab projects) runs instead of its prompt. A
 * port, so the scheduled task runner polls without importing the Jira, GitLab, and trigger
 * modules that implement it. The error's message is shown on the trigger.
 */
export class ScheduledTaskPoller extends Context.Service<
  ScheduledTaskPoller,
  { readonly poll: (task: ScheduledTask) => Effect.Effect<void, ScheduledTaskError> }
>()("t3/scheduledTasks/ScheduledTaskPoller") {}
