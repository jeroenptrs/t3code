import { canonicalPathIdentity } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

export interface WorkspaceMutationCoordinatorShape {
  readonly withWorkspace: <A, E, R>(
    workspaceRoot: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly withWorkspaceForProviderStartup: <A, E, R>(
    workspaceRoot: string,
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly providerStartupSettled: (threadId: string) => Effect.Effect<void>;
}

export class WorkspaceMutationCoordinator extends Context.Service<
  WorkspaceMutationCoordinator,
  WorkspaceMutationCoordinatorShape
>()("t3/orchestration/Services/WorkspaceMutationCoordinator") {}

export const canonicalWorkspaceIdentity = canonicalPathIdentity;

export const make = Effect.gen(function* () {
  interface LockEntry {
    readonly semaphore: Semaphore.Semaphore;
    readonly users: number;
  }

  const locks = yield* Ref.make<ReadonlyMap<string, LockEntry>>(new Map());
  const startupWaiters = yield* Ref.make<
    ReadonlyMap<string, ReadonlyArray<Deferred.Deferred<void>>>
  >(new Map());

  const acquireLock = Effect.fn("WorkspaceMutationCoordinator.acquireLock")(function* (
    workspaceRoot: string,
  ) {
    const identity = canonicalWorkspaceIdentity(workspaceRoot);
    const created = yield* Semaphore.make(1);
    return yield* Ref.modify(locks, (current) => {
      const existing = current.get(identity);
      const next = new Map(current);
      if (existing) {
        next.set(identity, { ...existing, users: existing.users + 1 });
        return [{ identity, semaphore: existing.semaphore }, next] as const;
      }
      next.set(identity, { semaphore: created, users: 1 });
      return [{ identity, semaphore: created }, next] as const;
    });
  });

  const releaseLock = (identity: string, semaphore: Semaphore.Semaphore) =>
    Ref.update(locks, (current) => {
      const entry = current.get(identity);
      if (!entry || entry.semaphore !== semaphore) return current;
      const next = new Map(current);
      if (entry.users === 1) next.delete(identity);
      else next.set(identity, { ...entry, users: entry.users - 1 });
      return next;
    });

  const withWorkspace: WorkspaceMutationCoordinatorShape["withWorkspace"] = (
    workspaceRoot,
    effect,
  ) =>
    Effect.acquireUseRelease(
      acquireLock(workspaceRoot),
      ({ semaphore }) => semaphore.withPermits(1)(effect),
      ({ identity, semaphore }) => releaseLock(identity, semaphore),
    );

  const withWorkspaceForProviderStartup: WorkspaceMutationCoordinatorShape["withWorkspaceForProviderStartup"] =
    (workspaceRoot, threadId, effect) =>
      withWorkspace(
        workspaceRoot,
        Effect.acquireUseRelease(
          Deferred.make<void>().pipe(
            Effect.tap((waiter) =>
              Ref.update(startupWaiters, (current) => {
                const next = new Map(current);
                next.set(threadId, [...(current.get(threadId) ?? []), waiter]);
                return next;
              }),
            ),
          ),
          (waiter) => effect.pipe(Effect.tap(() => Deferred.await(waiter))),
          (waiter) =>
            Ref.update(startupWaiters, (current) => {
              const remaining = (current.get(threadId) ?? []).filter(
                (candidate) => candidate !== waiter,
              );
              const next = new Map(current);
              if (remaining.length === 0) next.delete(threadId);
              else next.set(threadId, remaining);
              return next;
            }),
        ),
      );

  const providerStartupSettled = (threadId: string) =>
    Ref.get(startupWaiters).pipe(
      Effect.flatMap((current) => {
        const waiters = current.get(threadId) ?? [];
        return Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, undefined), {
          discard: true,
        });
      }),
    );

  return WorkspaceMutationCoordinator.of({
    withWorkspace,
    withWorkspaceForProviderStartup,
    providerStartupSettled,
  });
});

export const layer = Layer.effect(WorkspaceMutationCoordinator, make);
