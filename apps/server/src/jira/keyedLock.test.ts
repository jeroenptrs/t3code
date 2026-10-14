import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { makeKeyedLock } from "./keyedLock.ts";

it.effect("runs one effect per key at a time and forgets a key once nobody holds it", () =>
  Effect.gen(function* () {
    const lock = makeKeyedLock<string>();
    const order: Array<string> = [];
    const release = yield* Deferred.make<void>();
    const started = yield* Deferred.make<void>();

    const first = yield* lock
      .withLock("a")(
        Effect.gen(function* () {
          order.push("first:start");
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          order.push("first:end");
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const second = yield* lock
      .withLock("a")(Effect.sync(() => void order.push("second")))
      .pipe(Effect.forkChild);
    // Another key does not wait.
    yield* lock.withLock("b")(Effect.sync(() => void order.push("other")));
    const waiter = yield* lock.withLock("a")(Effect.void).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(waiter);
    assert.equal(lock.size(), 1);

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.deepStrictEqual(order, ["first:start", "other", "first:end", "second"]);
    assert.equal(lock.size(), 0);

    // A failing holder lets go too.
    yield* lock.withLock("c")(Effect.fail("boom")).pipe(Effect.flip);
    assert.equal(lock.size(), 0);
  }),
);
