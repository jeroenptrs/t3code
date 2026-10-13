import { expect, it } from "@effect/vitest";
import { JiraError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as JiraReadCache from "./JiraReadCache.ts";

it.effect("reuses a read until its kind's TTL passes", () =>
  Effect.gen(function* () {
    const cache = yield* JiraReadCache.make;
    const reads = yield* Ref.make(0);
    const lookup = Ref.updateAndGet(reads, (count) => count + 1);

    expect(yield* cache.get("issue", "bot:ABC-1", lookup)).toBe(1);
    expect(yield* cache.get("issue", "bot:ABC-1", lookup)).toBe(1);
    // A different key, and the same key under another kind, are separate entries.
    expect(yield* cache.get("issue", "bot:ABC-2", lookup)).toBe(2);
    expect(yield* cache.get("search", "bot:ABC-1", lookup)).toBe(3);

    yield* TestClock.adjust("29 seconds");
    expect(yield* cache.get("issue", "bot:ABC-1", lookup)).toBe(1);
    yield* TestClock.adjust("1 second");
    expect(yield* cache.get("issue", "bot:ABC-1", lookup)).toBe(4);
    // Search lives for a minute.
    expect(yield* cache.get("search", "bot:ABC-1", lookup)).toBe(3);
    yield* TestClock.adjust("30 seconds");
    expect(yield* cache.get("search", "bot:ABC-1", lookup)).toBe(5);
  }),
);

it.effect("does not cache failures", () =>
  Effect.gen(function* () {
    const cache = yield* JiraReadCache.make;
    const reads = yield* Ref.make(0);
    const failing = Ref.update(reads, (count) => count + 1).pipe(
      Effect.andThen(Effect.fail(new JiraError({ reason: "unavailable", message: "Down." }))),
    );

    yield* cache.get("myself", "bot", failing).pipe(Effect.flip);
    yield* cache.get("myself", "bot", failing).pipe(Effect.flip);
    expect(yield* Ref.get(reads)).toBe(2);
  }),
);

it.effect("concurrent reads of one key share a single lookup", () =>
  Effect.gen(function* () {
    const cache = yield* JiraReadCache.make;
    const reads = yield* Ref.make(0);
    const release = yield* Deferred.make<void>();
    const lookup = Ref.updateAndGet(reads, (count) => count + 1).pipe(
      Effect.tap(() => Deferred.await(release)),
    );

    const first = yield* cache.get("fields", "bot", lookup).pipe(Effect.forkChild);
    const second = yield* cache.get("fields", "bot", lookup).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);
    expect([yield* Fiber.join(first), yield* Fiber.join(second)]).toEqual([1, 1]);
    expect(yield* Ref.get(reads)).toBe(1);
  }),
);

it.effect("a refresh skips the stored and in-flight reads and stores its own", () =>
  Effect.gen(function* () {
    const cache = yield* JiraReadCache.make;
    const reads = yield* Ref.make(0);
    const lookup = Ref.updateAndGet(reads, (count) => count + 1);

    expect(yield* cache.get("issue", "bot:ABC-1", lookup)).toBe(1);
    expect(yield* cache.get("issue", "bot:ABC-1", lookup, { refresh: true })).toBe(2);
    expect(yield* cache.get("issue", "bot:ABC-1", lookup)).toBe(2);

    const release = yield* Deferred.make<void>();
    const slow = Ref.updateAndGet(reads, (count) => count + 1).pipe(
      Effect.tap(() => Deferred.await(release)),
    );
    const pending = yield* cache.get("search", "bot", slow).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    expect(yield* cache.get("search", "bot", lookup, { refresh: true })).toBe(4);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(pending)).toBe(3);
    // The older in-flight read finishing late does not replace the refreshed value.
    expect(yield* cache.get("search", "bot", lookup)).toBe(4);
  }),
);
