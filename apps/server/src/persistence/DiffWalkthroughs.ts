import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { DiffWalkthrough, ThreadId } from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type DiffWalkthroughRepositoryError,
} from "./Errors.ts";

const DiffWalkthroughJson = Schema.fromJsonString(DiffWalkthrough);

const UpsertDiffWalkthroughInput = Schema.Struct({
  /** `diffWalkthroughTargetKey` of the walkthrough's target, after host resolution. */
  key: Schema.String,
  kind: Schema.Literals(["pull-request", "thread-diff"]),
  threadId: Schema.NullOr(ThreadId),
  walkthrough: DiffWalkthroughJson,
  /** When it was stored, as an ISO instant. */
  updatedAt: Schema.String,
});
type UpsertDiffWalkthroughInput = typeof UpsertDiffWalkthroughInput.Type;

/**
 * Agent-written walkthroughs, one per target key. A walkthrough is read and replaced whole, so
 * the row holds the encoded document rather than a column per field.
 */
export class DiffWalkthroughRepository extends Context.Service<
  DiffWalkthroughRepository,
  {
    readonly getByKey: (
      key: string,
    ) => Effect.Effect<Option.Option<DiffWalkthrough>, DiffWalkthroughRepositoryError>;
    readonly upsert: (
      input: UpsertDiffWalkthroughInput,
    ) => Effect.Effect<void, DiffWalkthroughRepositoryError>;
  }
>()("t3/persistence/DiffWalkthroughs/DiffWalkthroughRepository") {}

function toSqlOrDecodeError(operation: string) {
  return (cause: unknown): DiffWalkthroughRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : new PersistenceSqlError({ operation, cause });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ walkthrough: DiffWalkthroughJson }),
    execute: (key) =>
      sql`
        SELECT walkthrough_json AS "walkthrough"
        FROM fork_diff_walkthroughs
        WHERE target_key = ${key}
      `,
  });

  const upsertRow = SqlSchema.void({
    Request: UpsertDiffWalkthroughInput,
    execute: ({ key, kind, threadId, walkthrough, updatedAt }) =>
      sql`
        INSERT INTO fork_diff_walkthroughs (
          target_key,
          target_kind,
          thread_id,
          walkthrough_json,
          updated_at
        )
        VALUES (${key}, ${kind}, ${threadId}, ${walkthrough}, ${updatedAt})
        ON CONFLICT (target_key)
        DO UPDATE SET
          target_kind = excluded.target_kind,
          thread_id = excluded.thread_id,
          walkthrough_json = excluded.walkthrough_json,
          updated_at = excluded.updated_at
      `,
  });

  return DiffWalkthroughRepository.of({
    getByKey: (key) =>
      getRow(key).pipe(
        Effect.map(Option.map((row) => row.walkthrough)),
        Effect.mapError(toSqlOrDecodeError("getDiffWalkthrough")),
      ),
    upsert: (input) =>
      upsertRow(input).pipe(Effect.mapError(toSqlOrDecodeError("upsertDiffWalkthrough"))),
  });
});

export const layer = Layer.effect(DiffWalkthroughRepository, make);
