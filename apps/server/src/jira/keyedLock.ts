import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * Runs effects for the same key one at a time. A key's lock exists only while an effect holds
 * or waits for it, so locks for keys that come and go (users, proposals) never pile up.
 */
export const makeKeyedLock = <K>() => {
  const entries = new Map<K, { readonly semaphore: Semaphore.Semaphore; users: number }>();
  const withLock =
    (key: K) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      // Counting in and out happens with interruption masked, so an interrupted waiter is
      // still counted out.
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          let entry = entries.get(key);
          if (entry === undefined) {
            entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
            entries.set(key, entry);
          }
          entry.users += 1;
          const held = entry;
          return restore(held.semaphore.withPermit(effect)).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                held.users -= 1;
                if (held.users === 0 && entries.get(key) === held) entries.delete(key);
              }),
            ),
          );
        }),
      );
  return {
    withLock,
    /** How many keys are held or waited on. */
    size: () => entries.size,
  };
};
