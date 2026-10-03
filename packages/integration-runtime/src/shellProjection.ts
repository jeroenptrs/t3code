import type {
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import type { T3Transport, T3TransportError } from "./transport.ts";

type ShellStreamEvent = Exclude<
  OrchestrationV2ShellStreamItem,
  { readonly kind: "snapshot" } | { readonly kind: "synchronized" }
>;

const upsertById = <T extends { readonly id: unknown }>(
  items: ReadonlyArray<T>,
  item: T,
): ReadonlyArray<T> =>
  items.some((candidate) => candidate.id === item.id)
    ? items.map((candidate) => (candidate.id === item.id ? item : candidate))
    : [...items, item];

/**
 * Applies one shell delta. Archived threads leave the projection: integrations
 * only present active conversations, and the archive has its own subscription.
 */
export function applyShellStreamEvent(
  snapshot: OrchestrationV2ShellSnapshot,
  event: ShellStreamEvent,
): OrchestrationV2ShellSnapshot {
  if (event.sequence <= snapshot.snapshotSequence) return snapshot;

  switch (event.kind) {
    case "project.updated":
      return {
        ...snapshot,
        projects: upsertById(snapshot.projects, event.project),
        snapshotSequence: event.sequence,
      };
    case "project.removed":
      return {
        ...snapshot,
        projects: snapshot.projects.filter((project) => project.id !== event.projectId),
        snapshotSequence: event.sequence,
      };
    case "thread.updated":
      return {
        ...snapshot,
        threads:
          event.location === "active"
            ? upsertById(snapshot.threads, event.thread)
            : snapshot.threads.filter((thread) => thread.id !== event.thread.id),
        snapshotSequence: event.sequence,
      };
    case "thread.removed":
      return {
        ...snapshot,
        threads: snapshot.threads.filter((thread) => thread.id !== event.threadId),
        snapshotSequence: event.sequence,
      };
  }
}

export function applyShellStreamItem(
  snapshot: OrchestrationV2ShellSnapshot | null,
  item: OrchestrationV2ShellStreamItem,
): OrchestrationV2ShellSnapshot | null {
  if (item.kind === "synchronized") return snapshot;
  if (item.kind === "snapshot") return item.snapshot;
  return snapshot === null ? null : applyShellStreamEvent(snapshot, item);
}

export interface ShellProjection {
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  readonly getSnapshot: () => OrchestrationV2ShellSnapshot | null;
  readonly refresh: () => Effect.Effect<OrchestrationV2ShellSnapshot, T3TransportError>;
  readonly subscribe: (listener: (snapshot: OrchestrationV2ShellSnapshot) => void) => () => void;
}

export function makeShellProjection(input: {
  readonly transport: T3Transport;
  readonly retryDelayMs?: number;
  readonly maximumRetryDelayMs?: number;
  readonly sleep?: (delayMs: number) => Effect.Effect<void>;
  readonly onError?: (error: unknown) => void;
}): ShellProjection {
  const listeners = new Set<(snapshot: OrchestrationV2ShellSnapshot) => void>();
  const retryDelayMs = input.retryDelayMs ?? 250;
  const maximumRetryDelayMs = input.maximumRetryDelayMs ?? 30_000;
  const sleep = input.sleep ?? Effect.sleep;
  let nextRetryDelayMs = retryDelayMs;
  let snapshot: OrchestrationV2ShellSnapshot | null = null;
  let authoritativeStreamEpoch = 0;
  let fiber: ReturnType<typeof Effect.runFork> | null = null;
  let stopping = false;

  const reportError = (error: unknown): void => {
    try {
      input.onError?.(error);
    } catch {
      // Diagnostics must never terminate the projection.
    }
  };

  const publish = (next: OrchestrationV2ShellSnapshot): void => {
    snapshot = next;
    nextRetryDelayMs = retryDelayMs;
    for (const listener of listeners) {
      try {
        listener(next);
      } catch (error) {
        reportError(error);
      }
    }
  };

  const refresh = () =>
    Effect.suspend(() => {
      const startedAtStreamEpoch = authoritativeStreamEpoch;
      return input.transport.getShellSnapshot().pipe(
        Effect.map((next) => {
          // A stream replacement establishes a new server epoch. Numeric
          // sequences from an HTTP request started in the previous epoch are
          // no longer comparable, even when that delayed response is higher.
          if (
            startedAtStreamEpoch === authoritativeStreamEpoch &&
            (snapshot === null || next.snapshotSequence >= snapshot.snapshotSequence)
          ) {
            publish(next);
          }
          return snapshot ?? next;
        }),
      );
    });

  const synchronizeOnce = Effect.gen(function* () {
    if (snapshot === null) {
      yield* refresh().pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            reportError(error);
          }),
        ),
      );
    }

    const afterSequence = snapshot?.snapshotSequence;
    yield* input.transport
      .subscribeShell({
        ...(afterSequence === undefined ? {} : { afterSequence }),
        requestCompletionMarker: true,
      })
      .pipe(
        Stream.runForEach((item) =>
          Effect.sync(() => {
            if (item.kind === "snapshot") authoritativeStreamEpoch += 1;
            const next = applyShellStreamItem(snapshot, item);
            if (next !== null && next !== snapshot) publish(next);
          }),
        ),
      );
  });

  const run = Effect.gen(function* () {
    while (true) {
      const result = yield* Effect.exit(synchronizeOnce);
      if (Exit.isFailure(result)) {
        if (stopping) return yield* Effect.failCause(result.cause);
        reportError(Cause.squash(result.cause));
      }
      yield* sleep(nextRetryDelayMs);
      nextRetryDelayMs = Math.min(
        maximumRetryDelayMs,
        Math.max(retryDelayMs, nextRetryDelayMs * 2),
      );
    }
  });

  return {
    start: () => {
      if (fiber !== null) return;
      stopping = false;
      fiber = Effect.runFork(run);
    },
    stop: async () => {
      const active = fiber;
      stopping = true;
      fiber = null;
      if (active !== null) {
        await Effect.runPromise(Fiber.interrupt(active).pipe(Effect.asVoid));
      }
    },
    getSnapshot: () => snapshot,
    refresh,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
