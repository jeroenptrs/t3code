import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SecureStore from "expo-secure-store";

// Copied from apps/mobile/src/persistence/mobile-secure-storage.ts.

const TvSecureStorageOperation = Schema.Literals(["read", "write", "delete"]);

export class TvSecureStorageError extends Schema.TaggedError<TvSecureStorageError>()(
  "TvSecureStorageError",
  {
    operation: TvSecureStorageOperation,
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `TV secure storage operation ${this.operation} failed for key ${this.key}.`;
  }
}

export class TvSecureStorage extends Context.Service<
  TvSecureStorage,
  {
    readonly getItem: (key: string) => Effect.Effect<string | null, TvSecureStorageError>;
    readonly setItem: (key: string, value: string) => Effect.Effect<void, TvSecureStorageError>;
    readonly removeItem: (key: string) => Effect.Effect<void, TvSecureStorageError>;
  }
>()("@t3tools/tv/persistence/TvSecureStorage") {}

export const make = TvSecureStorage.of({
  getItem: Effect.fn("TvSecureStorage.getItem")((key) =>
    Effect.tryPromise({
      try: () => SecureStore.getItemAsync(key),
      catch: (cause) => new TvSecureStorageError({ operation: "read", key, cause }),
    }),
  ),
  setItem: Effect.fn("TvSecureStorage.setItem")((key, value) =>
    Effect.tryPromise({
      try: () => SecureStore.setItemAsync(key, value),
      catch: (cause) => new TvSecureStorageError({ operation: "write", key, cause }),
    }),
  ),
  removeItem: Effect.fn("TvSecureStorage.removeItem")((key) =>
    Effect.tryPromise({
      try: () => SecureStore.deleteItemAsync(key),
      catch: (cause) => new TvSecureStorageError({ operation: "delete", key, cause }),
    }),
  ),
});

export const layer = Layer.succeed(TvSecureStorage, make);
