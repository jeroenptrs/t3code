import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { applyShellStreamItem, makeShellProjection } from "./shellProjection.ts";
import { T3TransportError, type T3Transport } from "./transport.ts";

const project = (id: string): OrchestrationProjectShell =>
  ({ id: ProjectId.make(id), title: id }) as OrchestrationProjectShell;

const thread = (id: string, projectId = "project-a"): OrchestrationThreadShell =>
  ({
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    title: id,
  }) as OrchestrationThreadShell;

const snapshot = (
  sequence: number,
  projects: ReadonlyArray<OrchestrationProjectShell> = [project("project-a")],
  threads: ReadonlyArray<OrchestrationThreadShell> = [thread("thread-a")],
): OrchestrationShellSnapshot =>
  ({
    snapshotSequence: sequence,
    projects,
    threads,
    updatedAt: "2026-08-02T00:00:00.000Z",
  }) as OrchestrationShellSnapshot;

const transport = (input: {
  readonly initial: OrchestrationShellSnapshot;
  readonly subscribe: T3Transport["subscribeShell"];
}): T3Transport => ({
  close: () => Effect.void,
  validateSession: () => Effect.die("not used"),
  getShellSnapshot: () => Effect.succeed(input.initial),
  subscribeShell: input.subscribe,
  getThreadSnapshot: () => Effect.die("not used"),
  dispatch: () => Effect.die("not used"),
  getServerConfig: () => Effect.die("not used"),
  listRefs: () => Effect.die("not used"),
  subscribeVcsStatus: () => Stream.never,
  switchRef: () => Effect.die("not used"),
  dispatchBootstrap: () => Effect.die("not used"),
});

describe("shell stream projection", () => {
  it("applies upserts and removals while ignoring duplicate or out-of-order events", () => {
    const initial = snapshot(5);
    const duplicate = applyShellStreamItem(initial, {
      kind: "thread-removed",
      sequence: 5,
      threadId: ThreadId.make("thread-a"),
    });
    expect(duplicate).toBe(initial);

    const withProject = applyShellStreamItem(initial, {
      kind: "project-upserted",
      sequence: 6,
      project: project("project-b"),
    });
    const withThread = applyShellStreamItem(withProject, {
      kind: "thread-upserted",
      sequence: 7,
      thread: thread("thread-b", "project-b"),
    });
    const withoutThread = applyShellStreamItem(withThread, {
      kind: "thread-removed",
      sequence: 8,
      threadId: ThreadId.make("thread-a"),
    });
    const withoutProject = applyShellStreamItem(withoutThread, {
      kind: "project-removed",
      sequence: 9,
      projectId: ProjectId.make("project-a"),
    });

    expect(withoutProject?.snapshotSequence).toBe(9);
    expect(withoutProject?.projects.map((item) => item.id)).toEqual(["project-b"]);
    expect(withoutProject?.threads.map((item) => item.id)).toEqual(["thread-b"]);
  });

  it("accepts an authoritative replacement snapshot and ignores synchronization markers", () => {
    const initial = snapshot(12);
    const replacement = snapshot(3, [project("replacement")], []);
    expect(applyShellStreamItem(initial, { kind: "snapshot", snapshot: replacement })).toBe(
      replacement,
    );
    expect(applyShellStreamItem(initial, { kind: "synchronized" })).toBe(initial);
    expect(
      applyShellStreamItem(null, {
        kind: "thread-upserted",
        sequence: 1,
        thread: thread("orphan"),
      }),
    ).toBeNull();
  });

  it.effect(
    "resumes a completed subscription from the latest applied sequence and stops cleanly",
    () =>
      Effect.gen(function* () {
        const secondSubscribed = yield* Deferred.make<void>();
        const inputs: Array<{ readonly afterSequence?: number }> = [];
        const updates: OrchestrationShellSnapshot[] = [];
        let subscription = 0;
        const projection = makeShellProjection({
          transport: transport({
            initial: snapshot(10),
            subscribe: (input) => {
              inputs.push(input);
              subscription += 1;
              if (subscription === 1) {
                return Stream.make({
                  kind: "thread-upserted",
                  sequence: 11,
                  thread: thread("thread-b"),
                } as OrchestrationShellStreamItem);
              }
              return Stream.fromEffect(Deferred.succeed(secondSubscribed, undefined)).pipe(
                Stream.flatMap(() => Stream.never as Stream.Stream<OrchestrationShellStreamItem>),
              );
            },
          }),
          retryDelayMs: 0,
        });
        projection.subscribe((next) => updates.push(next));

        projection.start();
        projection.start();
        yield* Deferred.await(secondSubscribed);

        expect(inputs).toEqual([
          { afterSequence: 10, requestCompletionMarker: true },
          { afterSequence: 11, requestCompletionMarker: true },
        ]);
        expect(projection.getSnapshot()?.threads.map((item) => item.id)).toEqual([
          "thread-a",
          "thread-b",
        ]);
        expect(updates.map((item) => item.snapshotSequence)).toEqual([10, 11]);

        yield* Effect.promise(() => projection.stop());
      }),
  );

  it.effect("does not let a delayed pre-reset HTTP snapshot overwrite a stream reset", () =>
    Effect.gen(function* () {
      const streamItems = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const subscribed = yield* Deferred.make<void>();
      const refreshStarted = yield* Deferred.make<void>();
      const releaseRefresh = yield* Deferred.make<void>();
      const appliedSequenceThree = yield* Deferred.make<void>();
      let snapshotRead = 0;
      const projection = makeShellProjection({
        transport: {
          ...transport({
            initial: snapshot(50),
            subscribe: () =>
              Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                Stream.flatMap(() => Stream.fromQueue(streamItems)),
              ),
          }),
          getShellSnapshot: () => {
            snapshotRead += 1;
            if (snapshotRead === 1) return Effect.succeed(snapshot(50));
            return Deferred.succeed(refreshStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseRefresh)),
              Effect.as(snapshot(100, [project("old-server")], [thread("old-server")])),
            );
          },
        },
      });
      projection.subscribe((next) => {
        if (next.snapshotSequence === 3) {
          Deferred.doneUnsafe(appliedSequenceThree, Effect.void);
        }
      });

      projection.start();
      yield* Deferred.await(subscribed);
      const refreshing = yield* projection.refresh().pipe(Effect.forkChild);
      yield* Deferred.await(refreshStarted);
      yield* Queue.offer(streamItems, {
        kind: "snapshot",
        snapshot: snapshot(2, [project("new-server")], []),
      });
      yield* Queue.offer(streamItems, {
        kind: "thread-upserted",
        sequence: 3,
        thread: thread("new-thread", "new-server"),
      });
      yield* Deferred.await(appliedSequenceThree);
      yield* Deferred.succeed(releaseRefresh, undefined);
      const refreshed = yield* Fiber.join(refreshing);

      expect(refreshed.snapshotSequence).toBe(3);
      expect(projection.getSnapshot()?.projects.map((item) => item.id)).toEqual(["new-server"]);
      expect(projection.getSnapshot()?.threads.map((item) => item.id)).toEqual(["new-thread"]);

      yield* Effect.promise(() => projection.stop());
    }),
  );

  it.effect("reports defects and resumes the projection loop with bounded retry", () =>
    Effect.gen(function* () {
      const retried = yield* Deferred.make<void>();
      const errors: unknown[] = [];
      let subscription = 0;
      const projection = makeShellProjection({
        transport: transport({
          initial: snapshot(10),
          subscribe: () => {
            subscription += 1;
            if (subscription === 1) {
              return Stream.die(new Error("stream defect"));
            }
            return Stream.fromEffect(Deferred.succeed(retried, undefined)).pipe(
              Stream.flatMap(() => Stream.never as Stream.Stream<OrchestrationShellStreamItem>),
            );
          },
        }),
        retryDelayMs: 0,
        maximumRetryDelayMs: 10,
        onError: (error) => errors.push(error),
      });

      projection.start();
      yield* Deferred.await(retried);

      expect(subscription).toBe(2);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
      expect((errors[0] as Error).message).toContain("stream defect");

      yield* Effect.promise(() => projection.stop());
    }),
  );

  it.effect("backs repeated subscription failures off to the configured bound", () =>
    Effect.gen(function* () {
      const subscribed = yield* Deferred.make<void>();
      const delays: number[] = [];
      let subscription = 0;
      const projection = makeShellProjection({
        transport: transport({
          initial: snapshot(10),
          subscribe: () => {
            subscription += 1;
            if (subscription <= 3) {
              return Stream.fail(
                new T3TransportError("unavailable", `failure-${subscription}`, null),
              );
            }
            return Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
              Stream.flatMap(() => Stream.never as Stream.Stream<OrchestrationShellStreamItem>),
            );
          },
        }),
        retryDelayMs: 5,
        maximumRetryDelayMs: 12,
        sleep: (delayMs) =>
          Effect.sync(() => {
            delays.push(delayMs);
          }),
      });

      projection.start();
      yield* Deferred.await(subscribed);

      expect(subscription).toBe(4);
      expect(delays).toEqual([5, 10, 12]);

      yield* Effect.promise(() => projection.stop());
    }),
  );
});
