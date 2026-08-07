import * as NodeServices from "@effect/platform-node/NodeServices";
import { ScheduledAutomationDefinition, ScheduledAutomationId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  ScheduledAutomationRepository,
  ScheduledAutomationRepositoryLive,
} from "./ScheduledAutomationRepository.ts";

const automationId = ScheduledAutomationId.make("nightly-maintenance");
const createdAt = "2026-08-03T09:00:00.000Z";
const definition = Schema.decodeUnknownSync(ScheduledAutomationDefinition)({
  name: "Nightly maintenance",
  prompt: "Inspect the workspace and fix the highest-priority issue.",
  projectId: "project-1",
  modelSelection: {
    instanceId: "codex-work",
    model: "gpt-5.6",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  worktreePolicy: { kind: "new-worktree", baseBranch: "main", startFromOrigin: true },
  setupScriptPolicy: "skip",
  schedule: { cron: "30 2 * * 1-5", timeZone: "Europe/Amsterdam", misfirePolicy: "latest-only" },
});

const memoryLayer = ScheduledAutomationRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

const layer = it.layer(memoryLayer);

layer("ScheduledAutomationRepository", (it) => {
  it.effect("creates disabled defaults and round-trips structured values", () =>
    Effect.gen(function* () {
      const repository = yield* ScheduledAutomationRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM local_scheduled_automations_v1`;
      const created = yield* repository.create({ id: automationId, definition, createdAt });
      assert.deepStrictEqual(created, {
        id: automationId,
        revision: 1,
        ...definition,
        enabled: false,
        enabledAt: null,
        lastScheduledFor: null,
        lastThreadId: null,
        lastOutcome: null,
        createdAt,
        updatedAt: createdAt,
      });
      assert.deepStrictEqual(yield* repository.list(), [created]);
      assert.deepStrictEqual(Option.getOrThrow(yield* repository.get(automationId)), created);
    }),
  );

  it.effect("increments revision once and returns the current row on a stale CAS", () =>
    Effect.gen(function* () {
      const repository = yield* ScheduledAutomationRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM local_scheduled_automations_v1`;
      const created = yield* repository.create({ id: automationId, definition, createdAt });
      const updated = yield* repository.compareAndSwapUpdate({
        automationId,
        expectedRevision: 1,
        replacement: {
          ...definition,
          name: "Updated maintenance",
          enabled: false,
          enabledAt: null,
          lastScheduledFor: null,
          lastThreadId: null,
          lastOutcome: null,
          updatedAt: "2026-08-03T09:01:00.000Z",
        },
      });
      assert.equal(updated.revision, created.revision + 1);

      const before = yield* sql<Record<string, unknown>>`
        SELECT * FROM local_scheduled_automations_v1 WHERE id = ${automationId}
      `;
      const conflict = yield* Effect.flip(
        repository.compareAndSwapUpdate({
          automationId,
          expectedRevision: 1,
          replacement: {
            ...definition,
            name: "Stale overwrite",
            enabled: true,
            enabledAt: "2026-08-03T09:02:00.000Z",
            lastScheduledFor: null,
            lastThreadId: null,
            lastOutcome: null,
            updatedAt: "2026-08-03T09:02:00.000Z",
          },
        }),
      );
      assert.equal(conflict._tag, "ScheduledAutomationConflictError");
      if (conflict._tag === "ScheduledAutomationConflictError") {
        assert.deepStrictEqual(conflict.current, updated);
      }
      const after = yield* sql<Record<string, unknown>>`
        SELECT * FROM local_scheduled_automations_v1 WHERE id = ${automationId}
      `;
      assert.deepStrictEqual(after, before);
    }),
  );

  it.effect("inspects valid rows while counting malformed definitions without exposing them", () =>
    Effect.gen(function* () {
      const repository = yield* ScheduledAutomationRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM local_scheduled_automations_v1`;
      const valid = yield* repository.create({ id: automationId, definition, createdAt });
      const secret = "repository-inspection-secret";
      const malformedDefinition = `{"prompt":"${secret}"}`;
      yield* sql`
        INSERT INTO local_scheduled_automations_v1 (
          id, schema_version, revision, definition_json, enabled, enabled_at,
          last_scheduled_for, last_thread_id, last_outcome_json, created_at, updated_at
        ) VALUES (
          'malformed-inspection-row', 1, 1, ${malformedDefinition}, 0, NULL,
          NULL, NULL, NULL, ${createdAt}, ${createdAt}
        )
      `;

      const inspection = yield* repository.inspect();
      assert.deepStrictEqual(inspection.automations, [valid]);
      assert.equal(inspection.malformedDefinitionCount, 1);
      assert.notEqual(inspection.automations[0]?.prompt, secret);
    }),
  );

  it.effect("claims an occurrence atomically and CAS-deletes", () =>
    Effect.gen(function* () {
      const repository = yield* ScheduledAutomationRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM local_scheduled_automations_v1`;
      yield* repository.create({ id: automationId, definition, createdAt });
      const enabled = yield* repository.compareAndSwapUpdate({
        automationId,
        expectedRevision: 1,
        replacement: {
          ...definition,
          enabled: true,
          enabledAt: "2026-08-03T09:01:00.000Z",
          lastScheduledFor: null,
          lastThreadId: null,
          lastOutcome: null,
          updatedAt: "2026-08-03T09:01:00.000Z",
        },
      });
      const changes = yield* repository.subscribe;
      const nextChange = yield* Stream.runHead(changes).pipe(Effect.forkScoped);
      const claimed = yield* repository.claimOccurrence({
        automationId,
        expectedRevision: enabled.revision,
        scheduledFor: "2026-08-04T00:30:00.000Z",
        lastThreadId: ThreadId.make("t3sa:v1:fixture:thread"),
        lastOutcome: {
          kind: "starting",
          scheduledFor: "2026-08-04T00:30:00.000Z",
          observedAt: "2026-08-04T00:31:00.000Z",
          coalescedCount: 2,
        },
        updatedAt: "2026-08-04T00:31:00.000Z",
      });
      assert.equal(claimed.revision, enabled.revision + 1);
      assert.equal(claimed.lastScheduledFor, "2026-08-04T00:30:00.000Z");
      assert.equal(claimed.lastOutcome?.kind, "starting");
      const change = Option.getOrThrow(yield* Fiber.join(nextChange));
      assert.equal(change.kind, "upserted");
      if (change.kind === "upserted") assert.deepStrictEqual(change.automation, claimed);

      const conflict = yield* Effect.flip(
        repository.compareAndSwapDelete({ automationId, expectedRevision: enabled.revision }),
      );
      assert.equal(conflict._tag, "ScheduledAutomationConflictError");
      yield* repository.compareAndSwapDelete({
        automationId,
        expectedRevision: claimed.revision,
      });
      assert.isTrue(Option.isNone(yield* repository.get(automationId)));
    }),
  );

  it.effect("refuses disabled, mismatched, duplicate, and backward occurrence claims", () =>
    Effect.gen(function* () {
      const repository = yield* ScheduledAutomationRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM local_scheduled_automations_v1`;
      const created = yield* repository.create({ id: automationId, definition, createdAt });
      const claim = (input: {
        expectedRevision: number;
        scheduledFor: string;
        outcomeScheduledFor?: string;
      }) =>
        repository.claimOccurrence({
          automationId,
          expectedRevision: input.expectedRevision,
          scheduledFor: input.scheduledFor,
          lastThreadId: ThreadId.make("t3sa:v1:guarded:thread"),
          lastOutcome: {
            kind: "starting",
            scheduledFor: input.outcomeScheduledFor ?? input.scheduledFor,
            observedAt: "2026-08-04T00:31:00.000Z",
            coalescedCount: 0,
          },
          updatedAt: "2026-08-04T00:31:00.000Z",
        });

      const disabled = yield* Effect.flip(
        claim({ expectedRevision: created.revision, scheduledFor: "2026-08-04T00:30:00.000Z" }),
      );
      assert.equal(disabled._tag, "ScheduledAutomationInvalidStateError");
      assert.deepStrictEqual(Option.getOrThrow(yield* repository.get(automationId)), created);

      const enabled = yield* repository.compareAndSwapUpdate({
        automationId,
        expectedRevision: created.revision,
        replacement: {
          ...definition,
          enabled: true,
          enabledAt: "2026-08-03T09:01:00.000Z",
          lastScheduledFor: null,
          lastThreadId: null,
          lastOutcome: null,
          updatedAt: "2026-08-03T09:01:00.000Z",
        },
      });
      const beforeActivation = yield* Effect.flip(
        claim({
          expectedRevision: enabled.revision,
          scheduledFor: "2026-08-03T09:01:00.000Z",
        }),
      );
      assert.equal(beforeActivation._tag, "ScheduledAutomationInvalidStateError");
      assert.deepStrictEqual(Option.getOrThrow(yield* repository.get(automationId)), enabled);
      const nonAbsolute = yield* Effect.flip(
        claim({
          expectedRevision: enabled.revision,
          scheduledFor: "2026-08-04T00:30:00",
        }),
      );
      assert.equal(nonAbsolute._tag, "ScheduledAutomationInvalidStateError");
      assert.deepStrictEqual(Option.getOrThrow(yield* repository.get(automationId)), enabled);
      const mismatched = yield* Effect.flip(
        claim({
          expectedRevision: enabled.revision,
          scheduledFor: "2026-08-04T00:30:00.000Z",
          outcomeScheduledFor: "2026-08-04T01:30:00.000Z",
        }),
      );
      assert.equal(mismatched._tag, "ScheduledAutomationInvalidStateError");
      assert.deepStrictEqual(Option.getOrThrow(yield* repository.get(automationId)), enabled);

      const skippedThreadId = ThreadId.make("t3sa:v1:missing-previous:thread");
      const missingPreviousThread = yield* Effect.flip(
        repository.claimOccurrence({
          automationId,
          expectedRevision: enabled.revision,
          scheduledFor: "2026-08-04T00:30:00.000Z",
          lastThreadId: skippedThreadId,
          lastOutcome: {
            kind: "skipped-active",
            scheduledFor: "2026-08-04T00:30:00.000Z",
            observedAt: "2026-08-04T00:31:00.000Z",
            coalescedCount: 0,
            previousThreadId: skippedThreadId,
          },
          updatedAt: "2026-08-04T00:31:00.000Z",
        }),
      );
      assert.equal(missingPreviousThread._tag, "ScheduledAutomationInvalidStateError");
      assert.deepStrictEqual(Option.getOrThrow(yield* repository.get(automationId)), enabled);

      const claimed = yield* claim({
        expectedRevision: enabled.revision,
        scheduledFor: "2026-08-04T00:30:00.000Z",
      });
      for (const scheduledFor of ["2026-08-04T00:30:00.000Z", "2026-08-03T00:30:00.000Z"]) {
        const refused = yield* Effect.flip(
          claim({ expectedRevision: claimed.revision, scheduledFor }),
        );
        assert.equal(refused._tag, "ScheduledAutomationInvalidStateError");
        assert.deepStrictEqual(Option.getOrThrow(yield* repository.get(automationId)), claimed);
      }
    }),
  );

  it.effect("linearizes a claim racing a disable so exactly one CAS wins", () =>
    Effect.gen(function* () {
      const repository = yield* ScheduledAutomationRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM local_scheduled_automations_v1`;
      yield* repository.create({ id: automationId, definition, createdAt });
      const enabled = yield* repository.compareAndSwapUpdate({
        automationId,
        expectedRevision: 1,
        replacement: {
          ...definition,
          enabled: true,
          enabledAt: "2026-08-03T09:01:00.000Z",
          lastScheduledFor: null,
          lastThreadId: null,
          lastOutcome: null,
          updatedAt: "2026-08-03T09:01:00.000Z",
        },
      });
      const results = yield* Effect.all(
        [
          Effect.result(
            repository.claimOccurrence({
              automationId,
              expectedRevision: enabled.revision,
              scheduledFor: "2026-08-04T00:30:00.000Z",
              lastThreadId: ThreadId.make("t3sa:v1:race:thread"),
              lastOutcome: {
                kind: "starting",
                scheduledFor: "2026-08-04T00:30:00.000Z",
                observedAt: "2026-08-04T00:31:00.000Z",
                coalescedCount: 0,
              },
              updatedAt: "2026-08-04T00:31:00.000Z",
            }),
          ),
          Effect.result(
            repository.compareAndSwapUpdate({
              automationId,
              expectedRevision: enabled.revision,
              replacement: {
                ...definition,
                enabled: false,
                enabledAt: null,
                lastScheduledFor: null,
                lastThreadId: null,
                lastOutcome: null,
                updatedAt: "2026-08-04T00:31:00.000Z",
              },
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter(Result.isSuccess).length, 1);
      const loser = results.find(Result.isFailure);
      assert.isDefined(loser);
      if (loser !== undefined && Result.isFailure(loser)) {
        assert.equal(loser.failure._tag, "ScheduledAutomationConflictError");
      }
      const current = Option.getOrThrow(yield* repository.get(automationId));
      assert.equal(current.revision, enabled.revision + 1);
      assert.isTrue(
        (!current.enabled && current.lastScheduledFor === null) ||
          (current.enabled && current.lastScheduledFor === "2026-08-04T00:30:00.000Z"),
      );
    }),
  );

  it.effect("rejects an unknown row schema version before returning it", () =>
    Effect.gen(function* () {
      const repository = yield* ScheduledAutomationRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM local_scheduled_automations_v1`;
      yield* repository.create({ id: automationId, definition, createdAt });
      yield* sql`PRAGMA ignore_check_constraints = ON`;
      yield* sql`
        UPDATE local_scheduled_automations_v1 SET schema_version = 2 WHERE id = ${automationId}
      `;
      const error = yield* Effect.flip(repository.list()).pipe(
        Effect.ensuring(sql`PRAGMA ignore_check_constraints = OFF`.pipe(Effect.ignore)),
      );
      assert.equal(error._tag, "PersistenceDecodeError");
    }),
  );
});

describe("ScheduledAutomationRepository restart", () => {
  it.effect("reconstructs byte-equivalent definitions, cursors, and outcomes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-scheduled-automation-",
      });
      const filename = path.join(directory, "state.sqlite");
      const sqlite = NodeSqliteClient.layer({ filename });
      const repositoryLayer = ScheduledAutomationRepositoryLive.pipe(Layer.provideMerge(sqlite));

      const expected = yield* Effect.gen(function* () {
        yield* runMigrations();
        const repository = yield* ScheduledAutomationRepository;
        yield* repository.create({ id: automationId, definition, createdAt });
        const enabled = yield* repository.compareAndSwapUpdate({
          automationId,
          expectedRevision: 1,
          replacement: {
            ...definition,
            enabled: true,
            enabledAt: "2026-08-03T09:01:00.000Z",
            lastScheduledFor: null,
            lastThreadId: null,
            lastOutcome: null,
            updatedAt: "2026-08-03T09:01:00.000Z",
          },
        });
        const claimed = yield* repository.claimOccurrence({
          automationId,
          expectedRevision: enabled.revision,
          scheduledFor: "2026-08-04T00:30:00.000Z",
          lastThreadId: ThreadId.make("t3sa:v1:restart:thread"),
          lastOutcome: {
            kind: "starting",
            scheduledFor: "2026-08-04T00:30:00.000Z",
            observedAt: "2026-08-04T00:31:00.000Z",
            coalescedCount: 4,
          },
          updatedAt: "2026-08-04T00:31:00.000Z",
        });
        return yield* repository.compareAndSwapUpdate({
          automationId,
          expectedRevision: claimed.revision,
          replacement: {
            ...definition,
            enabled: claimed.enabled,
            enabledAt: claimed.enabledAt,
            lastScheduledFor: claimed.lastScheduledFor,
            lastThreadId: claimed.lastThreadId,
            lastOutcome: {
              kind: "failed",
              scheduledFor: "2026-08-04T00:30:00.000Z",
              observedAt: "2026-08-04T00:32:00.000Z",
              coalescedCount: 4,
              code: "provider.unavailable",
              detail: "Provider was unavailable.",
              retryable: true,
            },
            updatedAt: "2026-08-04T00:32:00.000Z",
          },
        });
      }).pipe(Effect.provide(repositoryLayer), Effect.scoped);
      const restarted = yield* Effect.gen(function* () {
        yield* runMigrations();
        const repository = yield* ScheduledAutomationRepository;
        return yield* repository.list();
      }).pipe(Effect.provide(repositoryLayer), Effect.scoped);
      assert.deepStrictEqual(restarted, [expected]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
