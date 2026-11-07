import { assert, it } from "@effect/vitest";
import { ScheduledTaskId, type TriggerEvent } from "@t3tools/contracts";
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

it.effect(
  "runs a Jira query trigger only for its own poll's events, and a Jira trigger for none",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeScheduledTaskTestLayer;
      yield* Effect.gen(function* () {
        const tasks = yield* ScheduledTaskService.ScheduledTaskService;
        const triggers = yield* TriggerService.TriggerService;
        const query = (id: string) =>
          tasks.upsert(
            taskInput({
              id: ScheduledTaskId.make(id),
              title: id,
              schedule: {
                type: "jira_query",
                site: "acme.atlassian.net",
                jql: "project = PROJ",
                everyMs: 900_000,
              },
            }),
          );
        yield* query("query-a");
        yield* query("query-b");
        yield* tasks.upsert(taskInput({ id: ScheduledTaskId.make("jira"), title: "jira" }));

        const { payload } = jiraEvent() as Extract<TriggerEvent, { source: "jira" }>;
        const polled = {
          source: "jira_query",
          type: "issue.entered",
          triggerId: ScheduledTaskId.make("query-a"),
          occurredAt: "2026-11-05T10:00:00.000Z",
          payload: {
            ...payload,
            type: "issue.entered",
            changedFields: [],
            query: "project = PROJ",
          },
        } as const;
        assert.deepEqual(yield* triggers.raise(polled), { matched: 1 });
        assert.equal((yield* Queue.take(harness.launches)).title, "query-a");

        assert.deepEqual(
          yield* triggers.raise({ ...jiraEvent(), triggerId: ScheduledTaskId.make("query-a") }),
          { matched: 0 },
        );
        assert.deepEqual(yield* triggers.raise(jiraEvent()), { matched: 1 });
        assert.equal((yield* Queue.take(harness.launches)).title, "jira");
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
