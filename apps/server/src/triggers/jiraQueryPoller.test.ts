import { assert, it } from "@effect/vitest";
import { ScheduledTask } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as JiraApi from "../jira/JiraApi.ts";
import * as JiraIdentities from "../jira/JiraIdentities.ts";
import { jiraConfig, SITE } from "../jira/JiraLinks.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskPoller from "../scheduledTasks/ScheduledTaskPoller.ts";
import * as jiraQueryPoller from "./jiraQueryPoller.ts";
import * as TriggerSources from "./TriggerSources.ts";

const decodeTask = Schema.decodeUnknownSync(ScheduledTask);

const task = (schedule: Record<string, unknown>) =>
  decodeTask({
    id: "task:query",
    title: "Agent issues",
    prompt: "Pick up {{event.key}}",
    enabled: true,
    schedule: { type: "jira_query", everyMs: 900_000, ...schedule },
    projectId: "project-1",
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "auto",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  });

it.effect("reads a saved filter's JQL and its issues as the site's service identity", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (call: string) => Ref.update(calls, (all) => [...all, call]);
    const api = Layer.mock(JiraApi.JiraApi)({
      getFilter: (identity, id) =>
        record(`filter ${id} as ${identity.name}`).pipe(
          Effect.as({ id, name: "Agent work", jql: "labels = agent" }),
        ),
      searchJql: (identity, input) =>
        record(`search ${input.jql} as ${identity.name}`).pipe(
          Effect.as({ issues: [{ id: "1", key: "PROJ-1", fields: { summary: "Fix login" } }] }),
        ),
    });
    yield* Effect.gen(function* () {
      const poller = yield* ScheduledTaskPoller.ScheduledTaskPoller;
      yield* poller.poll(task({ site: SITE, filterId: "10042" }));
      assert.deepEqual(yield* Ref.get(calls), [
        "filter 10042 as bot",
        "search labels = agent as bot",
      ]);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ state_json: string }>`
        SELECT state_json FROM fork_trigger_observations WHERE key = 'task:query' || char(0)
      `;
      assert.deepEqual(rows, [{ state_json: "Agent work" }]);

      const failure = yield* poller
        .poll(task({ site: "other.atlassian.net", jql: "labels = agent" }))
        .pipe(Effect.flip);
      assert.equal(failure.message, "No Jira identity is configured for other.atlassian.net.");
      assert.equal((yield* Ref.get(calls)).length, 2);
    }).pipe(
      Effect.provide(
        jiraQueryPoller.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              api,
              Layer.succeed(JiraIdentities.JiraIdentities, JiraIdentities.make(jiraConfig)),
              TriggerSources.layer,
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
