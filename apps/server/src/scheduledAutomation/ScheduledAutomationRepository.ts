import {
  ScheduledAutomation,
  ScheduledAutomationConflictError,
  ScheduledAutomationDefinition,
  type ScheduledAutomationId,
  ScheduledAutomationInvalidStateError,
  ScheduledAutomationNotFoundError,
  ScheduledAutomationOutcome,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  toPersistenceSqlError,
} from "../persistence/Errors.ts";

const ScheduledAutomationDbRow = Schema.Struct({
  id: ScheduledAutomation.fields.id,
  schemaVersion: Schema.Literal(1),
  revision: ScheduledAutomation.fields.revision,
  definition: Schema.fromJsonString(ScheduledAutomationDefinition),
  enabled: Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  enabledAt: ScheduledAutomation.fields.enabledAt,
  lastScheduledFor: ScheduledAutomation.fields.lastScheduledFor,
  lastThreadId: ScheduledAutomation.fields.lastThreadId,
  lastOutcome: Schema.NullOr(Schema.fromJsonString(ScheduledAutomationOutcome)),
  createdAt: ScheduledAutomation.fields.createdAt,
  updatedAt: ScheduledAutomation.fields.updatedAt,
});

type ScheduledAutomationDbRow = typeof ScheduledAutomationDbRow.Type;
const decodeScheduledAutomationDbRows = Schema.decodeUnknownEffect(
  Schema.Array(ScheduledAutomationDbRow),
);
const decodeScheduledAutomationDbRow = Schema.decodeUnknownEffect(ScheduledAutomationDbRow);

export type ScheduledAutomationRepositoryError = PersistenceSqlError | PersistenceDecodeError;
export type ScheduledAutomationCasError =
  | ScheduledAutomationRepositoryError
  | ScheduledAutomationNotFoundError
  | ScheduledAutomationConflictError;
export type ScheduledAutomationClaimError =
  | ScheduledAutomationCasError
  | ScheduledAutomationInvalidStateError;

export type ScheduledAutomationRepositoryChange =
  | { readonly kind: "upserted"; readonly automation: ScheduledAutomation }
  | { readonly kind: "removed"; readonly automationId: ScheduledAutomationId };

export interface ScheduledAutomationCreateInput {
  readonly id: ScheduledAutomationId;
  readonly definition: ScheduledAutomationDefinition;
  readonly createdAt: string;
}

export interface ScheduledAutomationReplacement {
  readonly name: ScheduledAutomation["name"];
  readonly prompt: ScheduledAutomation["prompt"];
  readonly projectId: ScheduledAutomation["projectId"];
  readonly modelSelection: ScheduledAutomation["modelSelection"];
  readonly runtimeMode: ScheduledAutomation["runtimeMode"];
  readonly interactionMode: ScheduledAutomation["interactionMode"];
  readonly worktreePolicy: ScheduledAutomation["worktreePolicy"];
  readonly setupScriptPolicy: ScheduledAutomation["setupScriptPolicy"];
  readonly schedule: ScheduledAutomation["schedule"];
  readonly enabled: boolean;
  readonly enabledAt: ScheduledAutomation["enabledAt"];
  readonly lastScheduledFor: ScheduledAutomation["lastScheduledFor"];
  readonly lastThreadId: ScheduledAutomation["lastThreadId"];
  readonly lastOutcome: ScheduledAutomation["lastOutcome"];
  readonly updatedAt: ScheduledAutomation["updatedAt"];
}

export interface ScheduledAutomationCasUpdateInput {
  readonly automationId: ScheduledAutomationId;
  readonly expectedRevision: number;
  readonly replacement: ScheduledAutomationReplacement;
}

export interface ScheduledAutomationClaimInput {
  readonly automationId: ScheduledAutomationId;
  readonly expectedRevision: number;
  readonly scheduledFor: string;
  readonly lastThreadId: ThreadId;
  readonly lastOutcome: Extract<
    ScheduledAutomationOutcome,
    { readonly kind: "starting" } | { readonly kind: "skipped-active" }
  >;
  readonly updatedAt: string;
}

export interface ScheduledAutomationRepositoryShape {
  readonly list: () => Effect.Effect<
    ReadonlyArray<ScheduledAutomation>,
    ScheduledAutomationRepositoryError
  >;
  readonly inspect: () => Effect.Effect<
    {
      readonly automations: ReadonlyArray<ScheduledAutomation>;
      readonly malformedDefinitionCount: number;
    },
    PersistenceSqlError
  >;
  readonly get: (
    automationId: ScheduledAutomationId,
  ) => Effect.Effect<Option.Option<ScheduledAutomation>, ScheduledAutomationRepositoryError>;
  readonly create: (
    input: ScheduledAutomationCreateInput,
  ) => Effect.Effect<
    ScheduledAutomation,
    ScheduledAutomationRepositoryError | ScheduledAutomationConflictError
  >;
  readonly compareAndSwapUpdate: (
    input: ScheduledAutomationCasUpdateInput,
  ) => Effect.Effect<ScheduledAutomation, ScheduledAutomationCasError>;
  readonly compareAndSwapDelete: (input: {
    readonly automationId: ScheduledAutomationId;
    readonly expectedRevision: number;
  }) => Effect.Effect<void, ScheduledAutomationCasError>;
  readonly claimOccurrence: (
    input: ScheduledAutomationClaimInput,
  ) => Effect.Effect<ScheduledAutomation, ScheduledAutomationClaimError>;
  readonly subscribe: Effect.Effect<
    Stream.Stream<ScheduledAutomationRepositoryChange>,
    never,
    import("effect/Scope").Scope
  >;
}

export class ScheduledAutomationRepository extends Context.Service<
  ScheduledAutomationRepository,
  ScheduledAutomationRepositoryShape
>()("t3/scheduledAutomation/ScheduledAutomationRepository") {}

function fromDbRow(row: ScheduledAutomationDbRow): ScheduledAutomation {
  return {
    id: row.id,
    revision: row.revision,
    ...row.definition,
    enabled: row.enabled === 1,
    enabledAt: row.enabledAt,
    lastScheduledFor: row.lastScheduledFor,
    lastThreadId: row.lastThreadId,
    lastOutcome: row.lastOutcome,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const decodeRows = Effect.fn("ScheduledAutomationRepository.decodeRows")(function* (
  operation: string,
  rows: unknown,
) {
  return yield* decodeScheduledAutomationDbRows(rows).pipe(
    Effect.map((decoded) => decoded.map(fromDbRow)),
    Effect.mapError((cause) => PersistenceDecodeError.fromSchemaError(operation, cause)),
  );
});

const encodeDefinition = Schema.encodeEffect(Schema.fromJsonString(ScheduledAutomationDefinition));
const encodeOutcome = Schema.encodeEffect(Schema.fromJsonString(ScheduledAutomationOutcome));

function canonicalAbsoluteInstant(input: string): string | null {
  if (!/(?:z|[+-]\d{2}:?\d{2})$/i.test(input)) return null;
  const parsed = DateTime.make(input);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : null;
}

function mapEncodeError(operation: string) {
  return (cause: Schema.SchemaError) => PersistenceDecodeError.fromSchemaError(operation, cause);
}

export const makeScheduledAutomationRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<ScheduledAutomationRepositoryChange>();
  const mutationMutex = yield* Semaphore.make(1);
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

  const publishUpsert = (automation: ScheduledAutomation) =>
    PubSub.publish(changes, { kind: "upserted", automation }).pipe(Effect.asVoid);

  const selectAllRows = () =>
    sql<Record<string, unknown>>`
      SELECT
        id,
        schema_version AS "schemaVersion",
        revision,
        definition_json AS "definition",
        enabled,
        enabled_at AS "enabledAt",
        last_scheduled_for AS "lastScheduledFor",
        last_thread_id AS "lastThreadId",
        last_outcome_json AS "lastOutcome",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM local_scheduled_automations_v1
      ORDER BY created_at ASC, id ASC
    `.pipe(Effect.mapError(toPersistenceSqlError("ScheduledAutomationRepository.list:query")));

  const selectAll = () =>
    selectAllRows().pipe(
      Effect.flatMap((rows) => decodeRows("ScheduledAutomationRepository.list:decode", rows)),
    );

  const inspect: ScheduledAutomationRepositoryShape["inspect"] = () =>
    selectAllRows().pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => Effect.result(decodeScheduledAutomationDbRow(row))),
      ),
      Effect.map((results) => ({
        automations: results.flatMap((result) =>
          result._tag === "Success" ? [fromDbRow(result.success)] : [],
        ),
        malformedDefinitionCount: results.filter((result) => result._tag === "Failure").length,
      })),
    );

  const selectById = (automationId: ScheduledAutomationId) =>
    sql<Record<string, unknown>>`
      SELECT
        id,
        schema_version AS "schemaVersion",
        revision,
        definition_json AS "definition",
        enabled,
        enabled_at AS "enabledAt",
        last_scheduled_for AS "lastScheduledFor",
        last_thread_id AS "lastThreadId",
        last_outcome_json AS "lastOutcome",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM local_scheduled_automations_v1
      WHERE id = ${automationId}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ScheduledAutomationRepository.get:query")),
      Effect.flatMap((rows) => decodeRows("ScheduledAutomationRepository.get:decode", rows)),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  const currentOrError = Effect.fn("ScheduledAutomationRepository.currentOrError")(function* (
    automationId: ScheduledAutomationId,
    expectedRevision: number,
  ) {
    const current = yield* selectById(automationId);
    if (Option.isNone(current)) {
      return yield* new ScheduledAutomationNotFoundError({ automationId });
    }
    if (current.value.revision !== expectedRevision) {
      return yield* new ScheduledAutomationConflictError({ current: current.value });
    }
    return current.value;
  });

  const create: ScheduledAutomationRepositoryShape["create"] = Effect.fn(
    "ScheduledAutomationRepository.create",
  )(function* ({ id, definition, createdAt }) {
    const definitionJson = yield* encodeDefinition(definition).pipe(
      Effect.mapError(mapEncodeError("ScheduledAutomationRepository.create:encode")),
    );
    const rows = yield* sql<Record<string, unknown>>`
      INSERT INTO local_scheduled_automations_v1 (
        id, schema_version, revision, definition_json, enabled, enabled_at,
        last_scheduled_for, last_thread_id, last_outcome_json, created_at, updated_at
      )
      VALUES (${id}, 1, 1, ${definitionJson}, 0, NULL, NULL, NULL, NULL,
        ${createdAt}, ${createdAt})
      ON CONFLICT (id) DO NOTHING
      RETURNING
        id, schema_version AS "schemaVersion", revision,
        definition_json AS "definition", enabled, enabled_at AS "enabledAt",
        last_scheduled_for AS "lastScheduledFor", last_thread_id AS "lastThreadId",
        last_outcome_json AS "lastOutcome", created_at AS "createdAt", updated_at AS "updatedAt"
    `.pipe(Effect.mapError(toPersistenceSqlError("ScheduledAutomationRepository.create:query")));
    const inserted = yield* decodeRows("ScheduledAutomationRepository.create:decode", rows);
    if (inserted[0] !== undefined) {
      yield* publishUpsert(inserted[0]);
      return inserted[0];
    }
    const current = yield* selectById(id);
    if (Option.isSome(current)) {
      return yield* new ScheduledAutomationConflictError({ current: current.value });
    }
    return yield* new PersistenceSqlError({
      operation: "ScheduledAutomationRepository.create",
      detail: "Insert did not return a row.",
    });
  });

  const compareAndSwapUpdate: ScheduledAutomationRepositoryShape["compareAndSwapUpdate"] =
    Effect.fn("ScheduledAutomationRepository.compareAndSwapUpdate")(function* (input) {
      const nextRevision = input.expectedRevision + 1;
      const definition: ScheduledAutomationDefinition = {
        name: input.replacement.name,
        prompt: input.replacement.prompt,
        projectId: input.replacement.projectId,
        modelSelection: input.replacement.modelSelection,
        runtimeMode: input.replacement.runtimeMode,
        interactionMode: input.replacement.interactionMode,
        worktreePolicy: input.replacement.worktreePolicy,
        setupScriptPolicy: input.replacement.setupScriptPolicy,
        schedule: input.replacement.schedule,
      };
      const definitionJson = yield* encodeDefinition(definition).pipe(
        Effect.mapError(
          mapEncodeError("ScheduledAutomationRepository.compareAndSwapUpdate:encodeDefinition"),
        ),
      );
      const lastOutcomeJson =
        input.replacement.lastOutcome === null
          ? null
          : yield* encodeOutcome(input.replacement.lastOutcome).pipe(
              Effect.mapError(
                mapEncodeError("ScheduledAutomationRepository.compareAndSwapUpdate:encodeOutcome"),
              ),
            );
      const rows = yield* sql<Record<string, unknown>>`
        UPDATE local_scheduled_automations_v1
        SET revision = ${nextRevision},
            definition_json = ${definitionJson},
            enabled = ${input.replacement.enabled ? 1 : 0},
            enabled_at = ${input.replacement.enabledAt},
            last_scheduled_for = ${input.replacement.lastScheduledFor},
            last_thread_id = ${input.replacement.lastThreadId},
            last_outcome_json = ${lastOutcomeJson},
            updated_at = ${input.replacement.updatedAt}
        WHERE id = ${input.automationId} AND revision = ${input.expectedRevision}
        RETURNING
          id, schema_version AS "schemaVersion", revision,
          definition_json AS "definition", enabled, enabled_at AS "enabledAt",
          last_scheduled_for AS "lastScheduledFor", last_thread_id AS "lastThreadId",
          last_outcome_json AS "lastOutcome", created_at AS "createdAt", updated_at AS "updatedAt"
      `.pipe(
        Effect.mapError(
          toPersistenceSqlError("ScheduledAutomationRepository.compareAndSwapUpdate:query"),
        ),
      );
      const updated = yield* decodeRows(
        "ScheduledAutomationRepository.compareAndSwapUpdate:decode",
        rows,
      );
      if (updated[0] !== undefined) {
        yield* publishUpsert(updated[0]);
        return updated[0];
      }
      yield* currentOrError(input.automationId, input.expectedRevision);
      return yield* new PersistenceSqlError({
        operation: "ScheduledAutomationRepository.compareAndSwapUpdate",
        detail: "Compare-and-swap update did not return a row.",
      });
    });

  const compareAndSwapDelete: ScheduledAutomationRepositoryShape["compareAndSwapDelete"] =
    Effect.fn("ScheduledAutomationRepository.compareAndSwapDelete")(function* (input) {
      const rows = yield* sql<{ readonly id: string }>`
        DELETE FROM local_scheduled_automations_v1
        WHERE id = ${input.automationId} AND revision = ${input.expectedRevision}
        RETURNING id
      `.pipe(
        Effect.mapError(
          toPersistenceSqlError("ScheduledAutomationRepository.compareAndSwapDelete:query"),
        ),
      );
      if (rows.length > 0) {
        yield* PubSub.publish(changes, {
          kind: "removed",
          automationId: input.automationId,
        });
        return;
      }
      yield* currentOrError(input.automationId, input.expectedRevision);
      return yield* new PersistenceSqlError({
        operation: "ScheduledAutomationRepository.compareAndSwapDelete",
        detail: "Compare-and-swap delete did not remove a row.",
      });
    });

  const claimOccurrence: ScheduledAutomationRepositoryShape["claimOccurrence"] = Effect.fn(
    "ScheduledAutomationRepository.claimOccurrence",
  )(function* (input) {
    const canonicalScheduledFor = canonicalAbsoluteInstant(input.scheduledFor);
    if (
      canonicalScheduledFor === null ||
      canonicalScheduledFor !== input.scheduledFor ||
      input.lastOutcome.scheduledFor !== input.scheduledFor ||
      (input.lastOutcome.kind === "skipped-active" &&
        input.lastOutcome.previousThreadId !== input.lastThreadId)
    ) {
      const current = yield* currentOrError(input.automationId, input.expectedRevision);
      return yield* new ScheduledAutomationInvalidStateError({
        automationId: current.id,
        message:
          canonicalScheduledFor === null || canonicalScheduledFor !== input.scheduledFor
            ? "The claimed occurrence must be a canonical absolute UTC instant."
            : input.lastOutcome.scheduledFor !== input.scheduledFor
              ? "The outcome occurrence must match the claimed occurrence."
              : "A skipped occurrence must retain the previous thread identity.",
        current,
      });
    }
    const lastOutcomeJson = yield* encodeOutcome(input.lastOutcome).pipe(
      Effect.mapError(mapEncodeError("ScheduledAutomationRepository.claimOccurrence:encode")),
    );
    const nextRevision = input.expectedRevision + 1;
    const rows = yield* sql<Record<string, unknown>>`
      UPDATE local_scheduled_automations_v1
      SET revision = ${nextRevision},
          last_scheduled_for = ${input.scheduledFor},
          last_thread_id = ${input.lastThreadId},
          last_outcome_json = ${lastOutcomeJson},
          updated_at = ${input.updatedAt}
      WHERE id = ${input.automationId}
        AND revision = ${input.expectedRevision}
        AND enabled = 1
        AND enabled_at IS NOT NULL
        AND julianday(enabled_at) < julianday(${input.scheduledFor})
        AND (
          ${input.lastOutcome.kind === "starting" ? 1 : 0} = 1
          OR last_thread_id = ${input.lastThreadId}
        )
        AND (
          last_scheduled_for IS NULL
          OR julianday(last_scheduled_for) < julianday(${input.scheduledFor})
        )
      RETURNING
        id, schema_version AS "schemaVersion", revision,
        definition_json AS "definition", enabled, enabled_at AS "enabledAt",
        last_scheduled_for AS "lastScheduledFor", last_thread_id AS "lastThreadId",
        last_outcome_json AS "lastOutcome", created_at AS "createdAt", updated_at AS "updatedAt"
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ScheduledAutomationRepository.claimOccurrence:query")),
    );
    const claimed = yield* decodeRows("ScheduledAutomationRepository.claimOccurrence:decode", rows);
    if (claimed[0] !== undefined) {
      yield* publishUpsert(claimed[0]);
      return claimed[0];
    }

    const current = yield* currentOrError(input.automationId, input.expectedRevision);
    const message =
      !current.enabled || current.enabledAt === null
        ? "Disabled automations cannot claim occurrences."
        : Date.parse(current.enabledAt) >= Date.parse(input.scheduledFor)
          ? "The claimed occurrence must be strictly after the activation boundary."
          : input.lastOutcome.kind === "skipped-active" &&
              current.lastThreadId !== input.lastThreadId
            ? "A skipped occurrence must retain the row's previous thread identity."
            : current.lastScheduledFor !== null &&
                Date.parse(current.lastScheduledFor) >= Date.parse(input.scheduledFor)
              ? "The claimed occurrence must be newer than the durable cursor."
              : "The occurrence timestamp is invalid.";
    return yield* new ScheduledAutomationInvalidStateError({
      automationId: current.id,
      message,
      current,
    });
  });

  const subscribe: ScheduledAutomationRepositoryShape["subscribe"] = PubSub.subscribe(changes).pipe(
    Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
  );

  return ScheduledAutomationRepository.of({
    list: selectAll,
    inspect,
    get: selectById,
    create: (input) => mutationMutex.withPermits(1)(create(input)),
    compareAndSwapUpdate: (input) => mutationMutex.withPermits(1)(compareAndSwapUpdate(input)),
    compareAndSwapDelete: (input) => mutationMutex.withPermits(1)(compareAndSwapDelete(input)),
    claimOccurrence: (input) => mutationMutex.withPermits(1)(claimOccurrence(input)),
    subscribe,
  });
});

export const ScheduledAutomationRepositoryLive = Layer.effect(
  ScheduledAutomationRepository,
  makeScheduledAutomationRepository,
);
