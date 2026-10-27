import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ExpoCrypto from "expo-crypto";

import * as TvSecureStorage from "./secure-storage";

// Same key as mobile's agent-awareness device id: the relay and analytics see one id per install.
const DEVICE_ID_KEY = "t3code.agent-awareness.device-id";

export class TvDeviceIdGenerationError extends Schema.TaggedError<TvDeviceIdGenerationError>()(
  "TvDeviceIdGenerationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to generate the TV device id.";
  }
}

export class TvDeviceId extends Context.Service<
  TvDeviceId,
  {
    readonly loadOrCreate: Effect.Effect<
      string,
      TvSecureStorage.TvSecureStorageError | TvDeviceIdGenerationError
    >;
  }
>()("@t3tools/tv/persistence/TvDeviceId") {}

export const layer = Layer.effect(
  TvDeviceId,
  Effect.gen(function* () {
    const storage = yield* TvSecureStorage.TvSecureStorage;
    const lock = yield* Semaphore.make(1);
    const loadOrCreate = Effect.gen(function* () {
      const existing = yield* storage.getItem(DEVICE_ID_KEY);
      if (existing?.trim()) return existing;
      const deviceId = yield* Effect.try({
        try: () => ExpoCrypto.randomUUID(),
        catch: (cause) => new TvDeviceIdGenerationError({ cause }),
      });
      yield* storage.setItem(DEVICE_ID_KEY, deviceId);
      return deviceId;
    }).pipe(lock.withPermits(1));
    return TvDeviceId.of({ loadOrCreate });
  }),
);
