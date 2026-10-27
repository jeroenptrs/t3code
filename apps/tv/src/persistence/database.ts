import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SQLite from "expo-sqlite";

// A trimmed copy of apps/mobile/src/persistence/mobile-database.ts: the same client_cache
// table, without legacy file migration, pull request caches, or preferences.

// Import expo-sqlite statically: in development a dynamic import() fetches a lazy Metro bundle,
// which needs HMRClient.setup(), and tvOS never calls it. On tvOS expo-sqlite already stores the
// database under Library/Caches/SQLite; a purge just means refetching from the server.

const DATABASE_NAME = "t3code-tv-client.db";

export type ClientCacheKind = "shell" | "thread" | "server-config" | "vcs-refs";

const TvDatabaseOperation = Schema.Literals([
  "open",
  "migrate",
  "load-cache",
  "save-cache",
  "remove-cache",
  "clear-cache-kind",
  "clear-environment-cache",
]);

export class TvDatabaseError extends Schema.TaggedError<TvDatabaseError>()("TvDatabaseError", {
  operation: TvDatabaseOperation,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `TV database operation failed: ${this.operation}.`;
  }
}

function databaseError(operation: typeof TvDatabaseOperation.Type) {
  return (cause: unknown) => new TvDatabaseError({ operation, cause });
}

export class TvDatabase extends Context.Service<
  TvDatabase,
  {
    readonly loadCache: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
      cacheKey: string,
    ) => Effect.Effect<Option.Option<string>, TvDatabaseError>;
    readonly saveCache: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
      cacheKey: string,
      schemaVersion: number,
      payload: string,
    ) => Effect.Effect<void, TvDatabaseError>;
    readonly removeCache: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
      cacheKey: string,
    ) => Effect.Effect<void, TvDatabaseError>;
    readonly clearCacheKind: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
    ) => Effect.Effect<void, TvDatabaseError>;
    readonly clearEnvironmentCache: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, TvDatabaseError>;
  }
>()("@t3tools/tv/persistence/TvDatabase") {}

const makeAvailable = Effect.gen(function* () {
  const database = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => SQLite.openDatabaseAsync(DATABASE_NAME),
      catch: databaseError("open"),
    }),
    (openDatabase) => Effect.promise(() => openDatabase.closeAsync()).pipe(Effect.ignore),
  );

  yield* Effect.tryPromise({
    try: () =>
      database.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS client_cache (
          environment_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          cache_key TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          payload TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (environment_id, kind, cache_key)
        ) WITHOUT ROWID;
      `),
    catch: databaseError("migrate"),
  });

  return TvDatabase.of({
    loadCache: Effect.fn("TvDatabase.loadCache")((environmentId, kind, cacheKey) =>
      Effect.tryPromise({
        try: () =>
          database.getFirstAsync<{ readonly payload: string }>(
            `SELECT payload FROM client_cache
             WHERE environment_id = ? AND kind = ? AND cache_key = ?`,
            environmentId,
            kind,
            cacheKey,
          ),
        catch: databaseError("load-cache"),
      }).pipe(Effect.map((row) => Option.fromNullishOr(row?.payload))),
    ),
    saveCache: Effect.fn("TvDatabase.saveCache")(
      (environmentId, kind, cacheKey, schemaVersion, payload) =>
        Effect.tryPromise({
          try: async () => {
            await database.runAsync(
              `INSERT INTO client_cache
                (environment_id, kind, cache_key, schema_version, payload, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (environment_id, kind, cache_key) DO UPDATE SET
                 schema_version = excluded.schema_version,
                 payload = excluded.payload,
                 updated_at = excluded.updated_at`,
              environmentId,
              kind,
              cacheKey,
              schemaVersion,
              payload,
              Date.now(),
            );
          },
          catch: databaseError("save-cache"),
        }),
    ),
    removeCache: Effect.fn("TvDatabase.removeCache")((environmentId, kind, cacheKey) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync(
            "DELETE FROM client_cache WHERE environment_id = ? AND kind = ? AND cache_key = ?",
            environmentId,
            kind,
            cacheKey,
          ),
        catch: databaseError("remove-cache"),
      }).pipe(Effect.asVoid),
    ),
    clearCacheKind: Effect.fn("TvDatabase.clearCacheKind")((environmentId, kind) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync(
            "DELETE FROM client_cache WHERE environment_id = ? AND kind = ?",
            environmentId,
            kind,
          ),
        catch: databaseError("clear-cache-kind"),
      }).pipe(Effect.asVoid),
    ),
    clearEnvironmentCache: Effect.fn("TvDatabase.clearEnvironmentCache")((environmentId) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync("DELETE FROM client_cache WHERE environment_id = ?", environmentId),
        catch: databaseError("clear-environment-cache"),
      }).pipe(Effect.asVoid),
    ),
  });
});

// The open failure is logged once by `layer`; afterwards the caches behave as empty so callers
// do not log a warning for every load and save.
const unavailable = TvDatabase.of({
  loadCache: () => Effect.succeed(Option.none()),
  saveCache: () => Effect.void,
  removeCache: () => Effect.void,
  clearCacheKind: () => Effect.void,
  clearEnvironmentCache: () => Effect.void,
});

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause as { readonly code?: unknown }).code;
    return `${cause.name}${typeof code === "string" ? ` [${code}]` : ""}: ${cause.message}`;
  }
  return String(cause);
}

// A broken database must not stop the app from connecting; the app then runs without caches.
export const layer = Layer.effect(
  TvDatabase,
  Effect.result(makeAvailable).pipe(
    Effect.tap((result) =>
      result._tag === "Success"
        ? Effect.void
        : Effect.logWarning("TV database unavailable; client caches disabled.", {
            operation: result.failure.operation,
            cause: describeCause(result.failure.cause),
          }),
    ),
    Effect.map((result) => (result._tag === "Success" ? result.success : unavailable)),
  ),
);
