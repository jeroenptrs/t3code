import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ScheduledAutomationDefinition,
  ScheduledAutomationId,
  type MessageId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  type OrchestrationCommandReceipt,
  OrchestrationCommandReceiptRepository,
} from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { ScheduledAutomationBootstrap } from "./ScheduledAutomationBootstrap.ts";
import { deriveScheduledAutomationOccurrenceIdentity } from "./ScheduledAutomationOccurrence.ts";
import {
  ScheduledAutomationRepository,
  ScheduledAutomationRepositoryLive,
} from "./ScheduledAutomationRepository.ts";
import {
  ScheduledAutomationScheduler,
  layer as ScheduledAutomationSchedulerLive,
} from "./ScheduledAutomationScheduler.ts";
import { ScheduledAutomationValidation } from "./ScheduledAutomationValidation.ts";

const automationId = ScheduledAutomationId.make("scheduler-restart");
const definition = Schema.decodeUnknownSync(ScheduledAutomationDefinition)({
  name: "Restart fixture",
  prompt: "Resume safely.",
  projectId: "project-1",
  modelSelection: { instanceId: "codex", model: "gpt-5.6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  worktreePolicy: { kind: "current" },
  setupScriptPolicy: "skip",
  schedule: { cron: "* * * * *", timeZone: "UTC", misfirePolicy: "latest-only" },
});

interface RestartState {
  dispatches: number;
  receipt: Option.Option<OrchestrationCommandReceipt>;
  messageId: MessageId | null;
}

function restartLayer(state: RestartState) {
  return ScheduledAutomationSchedulerLive.pipe(
    Layer.provideMerge(ScheduledAutomationRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ServerConfig, {
          worktreesDir: "/tmp/t3-worktrees",
        } as ServerConfig["Service"]),
        Layer.succeed(ProjectionSnapshotQuery, {
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () =>
            Effect.succeed(
              state.messageId === null
                ? Option.none()
                : Option.some({
                    messages: [
                      {
                        id: state.messageId,
                        role: "user",
                        text: definition.prompt,
                        attachments: [],
                      },
                    ],
                  } as unknown as OrchestrationThread),
            ),
        } as unknown as ProjectionSnapshotQuery["Service"]),
        Layer.succeed(OrchestrationCommandReceiptRepository, {
          upsert: () => Effect.void,
          getByCommandId: () => Effect.succeed(state.receipt),
        } as unknown as OrchestrationCommandReceiptRepository["Service"]),
        Layer.succeed(ScheduledAutomationBootstrap, {
          dispatch: () =>
            Effect.sync(() => {
              state.dispatches += 1;
              return { sequence: 1 };
            }),
        }),
        Layer.succeed(ScheduledAutomationValidation, {
          validateLiveDefinition: () => Effect.void,
        }),
      ),
    ),
  );
}

const enabledRow = Effect.fn("ScheduledAutomationSchedulerRestartTest.enabledRow")(function* (
  repository: ScheduledAutomationRepository["Service"],
) {
  const created = yield* repository.create({
    id: automationId,
    definition,
    createdAt: "2026-08-04T10:00:00.000Z",
  });
  return yield* repository.compareAndSwapUpdate({
    automationId,
    expectedRevision: created.revision,
    replacement: {
      ...definition,
      enabled: true,
      enabledAt: "2026-08-04T10:00:00.000Z",
      lastScheduledFor: null,
      lastThreadId: null,
      lastOutcome: null,
      updatedAt: "2026-08-04T10:00:00.000Z",
    },
  });
});

it.effect("restart before claim creates one latest-only occurrence", () => {
  const state: RestartState = { dispatches: 0, receipt: Option.none(), messageId: null };
  return Effect.gen(function* () {
    const repository = yield* ScheduledAutomationRepository;
    const scheduler = yield* ScheduledAutomationScheduler;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM local_scheduled_automations_v1`;
    yield* enabledRow(repository);
    yield* TestClock.setTime(Date.parse("2026-08-04T10:10:00.000Z"));

    yield* scheduler.runOnce;
    const resumed = Option.getOrThrow(yield* repository.get(automationId));
    const rows = yield* sql<{
      readonly count: number;
      readonly revision: number;
      readonly lastScheduledFor: string | null;
    }>`
      SELECT COUNT(*) AS count, revision, last_scheduled_for AS lastScheduledFor
      FROM local_scheduled_automations_v1
      WHERE id = ${automationId}
    `;
    assert.equal(rows[0]?.count, 1);
    assert.equal(rows[0]?.revision, 4);
    assert.equal(rows[0]?.lastScheduledFor, "2026-08-04T10:10:00.000Z");
    assert.equal(resumed.lastOutcome?.kind, "started");
    assert.equal(resumed.lastOutcome?.coalescedCount, 9);
    assert.equal(state.dispatches, 1);
  }).pipe(Effect.provide(restartLayer(state)));
});

it.effect("restart after a durable starting claim resumes the same thread and cursor", () => {
  const state: RestartState = { dispatches: 0, receipt: Option.none(), messageId: null };
  return Effect.gen(function* () {
    const repository = yield* ScheduledAutomationRepository;
    const scheduler = yield* ScheduledAutomationScheduler;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM local_scheduled_automations_v1`;
    const enabled = yield* enabledRow(repository);
    const scheduledFor = "2026-08-04T10:01:00.000Z";
    const identity = deriveScheduledAutomationOccurrenceIdentity(
      { automationId, scheduledFor, worktreesDir: "/tmp/t3-worktrees" },
      path,
    );
    assert.isTrue(identity._tag === "Success");
    if (identity._tag === "Failure") return;
    const starting = yield* repository.claimOccurrence({
      automationId,
      expectedRevision: enabled.revision,
      scheduledFor,
      lastThreadId: identity.success.threadId,
      lastOutcome: {
        kind: "starting",
        scheduledFor,
        observedAt: scheduledFor,
        coalescedCount: 0,
      },
      updatedAt: scheduledFor,
    });
    assert.equal(starting.revision, 3);

    yield* TestClock.setTime(Date.parse("2026-08-04T10:01:30.000Z"));
    yield* scheduler.runOnce;
    const resumed = Option.getOrThrow(yield* repository.get(automationId));
    const count = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM local_scheduled_automations_v1 WHERE id = ${automationId}
    `;
    assert.equal(count[0]?.count, 1);
    assert.equal(resumed.revision, 4);
    assert.equal(resumed.lastScheduledFor, scheduledFor);
    assert.equal(resumed.lastThreadId, identity.success.threadId);
    assert.equal(resumed.lastOutcome?.kind, "started");
    assert.equal(state.dispatches, 1);
  }).pipe(Effect.provide(restartLayer(state)));
});

it.effect(
  "restart after accepted start receipt finalizes without another bootstrap side effect",
  () => {
    const state: RestartState = { dispatches: 0, receipt: Option.none(), messageId: null };
    return Effect.gen(function* () {
      const repository = yield* ScheduledAutomationRepository;
      const scheduler = yield* ScheduledAutomationScheduler;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM local_scheduled_automations_v1`;
      const enabled = yield* enabledRow(repository);
      const scheduledFor = "2026-08-04T10:01:00.000Z";
      const identity = deriveScheduledAutomationOccurrenceIdentity(
        { automationId, scheduledFor, worktreesDir: "/tmp/t3-worktrees" },
        path,
      );
      assert.isTrue(identity._tag === "Success");
      if (identity._tag === "Failure") return;
      yield* repository.claimOccurrence({
        automationId,
        expectedRevision: enabled.revision,
        scheduledFor,
        lastThreadId: identity.success.threadId,
        lastOutcome: {
          kind: "starting",
          scheduledFor,
          observedAt: scheduledFor,
          coalescedCount: 0,
        },
        updatedAt: scheduledFor,
      });
      state.receipt = Option.some({
        commandId: identity.success.phaseCommandIds.startTurn,
        aggregateKind: "thread",
        aggregateId: identity.success.threadId,
        acceptedAt: scheduledFor,
        resultSequence: 1,
        status: "accepted",
        error: null,
      });
      state.messageId = identity.success.messageId;

      yield* TestClock.setTime(Date.parse("2026-08-04T10:01:30.000Z"));
      yield* scheduler.runOnce;
      const reconciled = Option.getOrThrow(yield* repository.get(automationId));
      const count = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM local_scheduled_automations_v1 WHERE id = ${automationId}
      `;
      assert.equal(count[0]?.count, 1);
      assert.equal(reconciled.revision, 4);
      assert.equal(reconciled.lastScheduledFor, scheduledFor);
      assert.equal(reconciled.lastThreadId, identity.success.threadId);
      assert.equal(reconciled.lastOutcome?.kind, "started");
      assert.equal(state.dispatches, 0);
    }).pipe(Effect.provide(restartLayer(state)));
  },
);
