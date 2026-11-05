import { assert, it } from "@effect/vitest";
import { ScheduledTaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import {
  jiraEvent,
  makeScheduledTaskTestLayer,
  taskInput,
} from "../scheduledTasks/ScheduledTaskService.testkit.ts";
import * as TriggerService from "./TriggerService.ts";
import * as TriggerSources from "./TriggerSources.ts";

it.effect("runs only the enabled tasks of the event's source whose filters match", () =>
  Effect.gen(function* () {
    const harness = yield* makeScheduledTaskTestLayer;
    yield* Effect.gen(function* () {
      const tasks = yield* ScheduledTaskService.ScheduledTaskService;
      const triggers = yield* TriggerService.TriggerService;
      const save = (id: string, overrides: Parameters<typeof taskInput>[0]) =>
        tasks.upsert(taskInput({ id: ScheduledTaskId.make(id), title: id, ...overrides }));
      yield* save("unfiltered", {});
      yield* save("matching", {
        schedule: {
          type: "jira",
          filters: [
            { path: "event.type", op: "equals", value: "issue.status_changed" },
            { path: "event.labels", op: "equals", value: "agent" },
          ],
        },
      });
      yield* save("filtered", {
        schedule: {
          type: "jira",
          filters: [{ path: "event.status", op: "equals", value: "Done" }],
        },
      });
      yield* save("paused", { enabled: false });
      yield* save("other source", { schedule: { type: "gitlab" } });
      yield* save("manual", { schedule: { type: "manual" } });

      assert.deepEqual(yield* triggers.raise(jiraEvent({ labels: ["agent"] })), { matched: 2 });
      const launched = [yield* Queue.take(harness.launches), yield* Queue.take(harness.launches)];
      assert.sameMembers(
        launched.map((launch) => launch.title),
        ["unfiltered", "matching"],
      );
      assert.equal(yield* Queue.size(harness.launches), 0);

      assert.deepEqual(
        yield* triggers.raise({
          source: "manual",
          type: "manual",
          occurredAt: "2026-11-05T10:00:00.000Z",
          payload: { type: "manual" },
        }),
        { matched: 0 },
      );
      assert.equal(yield* Queue.size(harness.launches), 0);

      // Run now has no event to fill the prompt, so an event task refuses it like a webhook task.
      const runNow = yield* tasks
        .runNow({ id: ScheduledTaskId.make("matching") })
        .pipe(Effect.flip);
      assert.equal(
        runNow.message,
        "Event tasks run when a matching event arrives; their prompt needs one.",
      );
      assert.equal(yield* Queue.size(harness.launches), 0);
    }).pipe(
      Effect.provide(
        TriggerService.layer.pipe(
          Layer.provideMerge(harness.layer),
          Layer.provide(TriggerSources.layer),
        ),
      ),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
