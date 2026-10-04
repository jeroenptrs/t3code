import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { AuthUserId, ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const webhookTaskInput = (overrides: Record<string, unknown> = {}) =>
  decodeUpsertInput({
    id: "scheduled-task:hook",
    title: "Review PRs",
    prompt: "Review this PR: {{body.pull_request.url}}",
    enabled: true,
    schedule: { type: "webhook" },
    projectId: "project-webhook",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  });

const ada = AuthUserId.make("user-ada");
const grace = AuthUserId.make("user-grace");

const withService = <A, E>(
  body: (service: ScheduledTaskService.ScheduledTaskService["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO auth_users (
        user_id, tenant_id, object_id, status, role, email, display_name, created_at, updated_at
      ) VALUES
        (${ada}, 't', 'ada', 'active', 'operator', 'ada@example.com', 'Ada Lovelace',
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        (${grace}, 't', 'grace', 'active', 'operator', 'grace@example.com', NULL,
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `;
    const dependencies = Layer.mergeAll(
      NodePlatformCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    return yield* Effect.gen(function* () {
      return yield* body(yield* ScheduledTaskService.ScheduledTaskService);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));

it.effect("records the creating user and keeps them when someone else edits", () =>
  withService((service) =>
    Effect.gen(function* () {
      const created = yield* service.upsert(yield* webhookTaskInput(), ada);
      assert.deepStrictEqual(created.task.webhook?.createdByUser, {
        userId: ada,
        name: "Ada Lovelace",
      });

      const byGrace = yield* service.upsert(yield* webhookTaskInput({ title: "Edited" }), grace);
      assert.equal(byGrace.task.title, "Edited");
      assert.equal(byGrace.task.webhook?.createdByUser?.userId, ada);

      const byService = yield* service.upsert(yield* webhookTaskInput({ title: "Again" }));
      assert.equal(byService.task.webhook?.createdByUser?.userId, ada);
      assert.notProperty(byService.task.webhook, "tokenRotatedAt");
    }),
  ),
);

it.effect("records no creator for a session without a user", () =>
  withService((service) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput(), null);
      assert.isDefined(task.webhook);
      assert.notProperty(task.webhook, "createdByUser");
      // A later edit by a user does not claim the task.
      const edited = yield* service.upsert(yield* webhookTaskInput({ title: "Edited" }), ada);
      assert.notProperty(edited.task.webhook, "createdByUser");
    }),
  ),
);

it.effect("records who rotated the token and when", () =>
  withService((service) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput(), ada);
      const byGrace = yield* service.rotateWebhookToken({ id: task.id }, grace);
      // Grace has no display name, so her email labels her.
      assert.deepStrictEqual(byGrace.task.webhook?.tokenRotatedByUser, {
        userId: grace,
        name: "grace@example.com",
      });
      assert.isString(byGrace.task.webhook?.tokenRotatedAt);
      assert.equal(byGrace.task.webhook?.createdByUser?.userId, ada);

      const bySession = yield* service.rotateWebhookToken({ id: task.id }, null);
      assert.isString(bySession.task.webhook?.tokenRotatedAt);
      assert.notProperty(bySession.task.webhook, "tokenRotatedByUser");

      // A plain save keeps the rotation record.
      const saved = yield* service.upsert(yield* webhookTaskInput({ title: "Edited" }), ada);
      assert.equal(saved.task.webhook?.tokenRotatedAt, bySession.task.webhook?.tokenRotatedAt);
    }),
  ),
);

it.effect("drops the rotation record with the token when the task stops being a webhook", () =>
  withService((service) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput(), ada);
      yield* service.rotateWebhookToken({ id: task.id }, ada);
      yield* service.upsert(
        yield* webhookTaskInput({ schedule: { type: "interval", everyMs: 3_600_000 } }),
        ada,
      );
      const again = yield* service.upsert(yield* webhookTaskInput(), ada);
      assert.notProperty(again.task.webhook, "tokenRotatedAt");
      assert.notProperty(again.task.webhook, "tokenRotatedByUser");
      assert.equal(again.task.webhook?.createdByUser?.userId, ada);
    }),
  ),
);

it.effect("names a user who no longer exists as unknown rather than failing", () =>
  withService((service) =>
    Effect.gen(function* () {
      const removed = AuthUserId.make("user-removed");
      const { task } = yield* service.upsert(yield* webhookTaskInput(), removed);
      assert.deepStrictEqual(task.webhook?.createdByUser, { userId: removed, name: null });
      const { tasks } = yield* service.list();
      assert.deepStrictEqual(tasks[0]?.webhook?.createdByUser, { userId: removed, name: null });
    }),
  ),
);
