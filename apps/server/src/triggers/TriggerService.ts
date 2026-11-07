import type { ScheduledTask, ScheduledTaskError, TriggerEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { isPollSchedule } from "../scheduledTasks/Schedule.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import { describeFailedWebhookFilter } from "../scheduledTasks/webhookFilter.ts";
import { forkParked } from "../serverActivation.ts";
import { findFailedTriggerFilter } from "./triggerFilter.ts";
import * as TriggerSources from "./TriggerSources.ts";

/**
 * Runs the scheduled tasks an event matches: enabled tasks whose source is the event's, with
 * every filter passing. Events come from the trigger sources and from `raise`. Manual events
 * match nothing here; a manual task runs through Run now.
 */
export class TriggerService extends Context.Service<
  TriggerService,
  {
    readonly raise: (
      event: TriggerEvent,
    ) => Effect.Effect<{ readonly matched: number }, ScheduledTaskError>;
    /** Raises every event the trigger sources observe. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/triggers/TriggerService") {}

const filtersOf = (schedule: ScheduledTask["schedule"]) =>
  schedule.type === "jira" ||
  schedule.type === "gitlab" ||
  schedule.type === "slack" ||
  isPollSchedule(schedule)
    ? (schedule.filters ?? [])
    : [];

/** A polled trigger runs only its own poll's events; other triggers only unaddressed ones. */
const isAddressedTo = (task: ScheduledTask, event: TriggerEvent) =>
  isPollSchedule(task.schedule) ? event.triggerId === task.id : event.triggerId === undefined;

const make = Effect.gen(function* () {
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const sources = yield* TriggerSources.TriggerSources;

  const raise: TriggerService["Service"]["raise"] = Effect.fn("TriggerService.raise")(
    function* (event) {
      yield* Effect.annotateCurrentSpan({
        "trigger.source": event.source,
        "trigger.type": event.type,
      });
      if (event.source === "manual") return { matched: 0 };
      const { tasks } = yield* scheduledTasks.list();
      const matches: Array<ScheduledTask> = [];
      for (const task of tasks) {
        if (!task.enabled || task.schedule.type !== event.source || !isAddressedTo(task, event)) {
          continue;
        }
        const failed = findFailedTriggerFilter(filtersOf(task.schedule), event);
        if (failed === null) {
          matches.push(task);
          continue;
        }
        yield* Effect.logDebug("Trigger event filtered", {
          taskId: task.id,
          type: event.type,
          reason: describeFailedWebhookFilter(failed),
        });
      }
      yield* Effect.forEach(
        matches,
        (task) =>
          scheduledTasks.runForEvent(task, event).pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) =>
                Effect.logWarning("Trigger run failed", {
                  taskId: task.id,
                  type: event.type,
                  cause: Cause.pretty(cause),
                }),
            ),
          ),
        { discard: true },
      );
      return { matched: matches.length };
    },
  );

  const start: TriggerService["Service"]["start"] = Effect.fn("TriggerService.start")(function* () {
    yield* forkParked(
      Stream.runForEach(sources.events, (event) =>
        raise(event).pipe(
          Effect.catchTags({
            ScheduledTaskError: (error) =>
              Effect.logWarning("Trigger event dropped", {
                type: event.type,
                reason: error.message,
              }),
          }),
        ),
      ),
    );
  });

  return TriggerService.of({ raise, start });
});

export const layer = Layer.effect(TriggerService, make);
