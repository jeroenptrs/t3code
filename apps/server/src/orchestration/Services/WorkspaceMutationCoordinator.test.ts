import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { make } from "./WorkspaceMutationCoordinator.ts";

describe("WorkspaceMutationCoordinator", () => {
  it.effect("serializes canonical workspace aliases while allowing another workspace", () =>
    Effect.gen(function* () {
      const coordinator = yield* make;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const secondDone = yield* Deferred.make<void>();
      const order = yield* Ref.make<ReadonlyArray<string>>([]);

      yield* Effect.forkChild(
        coordinator.withWorkspace(
          "/repo-a/../repo-a",
          Ref.update(order, (items) => [...items, "a1-enter"]).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Ref.update(order, (items) => [...items, "a1-exit"])),
          ),
        ),
        { startImmediately: true },
      );
      yield* Deferred.await(entered);
      yield* Effect.forkChild(
        coordinator.withWorkspace(
          "/repo-a",
          Ref.update(order, (items) => [...items, "a2"]).pipe(
            Effect.andThen(Deferred.succeed(secondDone, undefined)),
          ),
        ),
        { startImmediately: true },
      );
      yield* coordinator.withWorkspace(
        "/repo-b",
        Ref.update(order, (items) => [...items, "b"]),
      );
      expect(yield* Ref.get(order)).toEqual(["a1-enter", "b"]);

      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(secondDone);
      expect(yield* Ref.get(order)).toEqual(["a1-enter", "b", "a1-exit", "a2"]);
    }),
  );

  it.effect("holds a workspace mutation until provider startup settles", () =>
    Effect.gen(function* () {
      const coordinator = yield* make;
      const dispatched = yield* Deferred.make<void>();
      const competingDone = yield* Deferred.make<void>();

      yield* Effect.forkChild(
        coordinator.withWorkspaceForProviderStartup(
          "/repo",
          "thread-1",
          Deferred.succeed(dispatched, undefined),
        ),
        { startImmediately: true },
      );
      yield* Deferred.await(dispatched);
      yield* Effect.forkChild(
        coordinator
          .withWorkspace("/repo", Deferred.succeed(competingDone, undefined))
          .pipe(Effect.asVoid),
        { startImmediately: true },
      );
      expect(yield* Deferred.isDone(competingDone)).toBe(false);

      yield* coordinator.providerStartupSettled("thread-1");
      yield* Deferred.await(competingDone);
    }),
  );
});
