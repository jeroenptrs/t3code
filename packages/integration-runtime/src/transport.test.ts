import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  type ClientOrchestrationCommand,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import {
  makeLiveT3Transport,
  makeServerConfigConnectionManager,
  type ServerConfigConnection,
} from "./transport.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const serverConfig = (environmentId: string): ServerConfig =>
  ({ environment: { environmentId: EnvironmentId.make(environmentId) } }) as ServerConfig;

describe("server config connection manager", () => {
  it.effect("re-reads renewable connection material when replacing a closed session", () =>
    Effect.gen(function* () {
      const connections: Array<string> = [];
      const credentials: Array<string> = [];
      const tickets: Array<string> = [];
      const reads: Array<number> = [];
      const closes: Array<number> = [];
      const subscriptions: Array<number> = [];
      const vcsSubscriptions: Array<number> = [];
      const disconnects: Array<Deferred.Deferred<never, Error>> = [];
      let connectionNumber = 0;

      const manager = yield* makeServerConfigConnectionManager(() =>
        Effect.gen(function* () {
          const number = ++connectionNumber;
          const credential = `credential-${number}`;
          const ticket = `ticket-${number}`;
          credentials.push(credential);
          tickets.push(ticket);
          connections.push(`connection-${number}`);
          const disconnected = yield* Deferred.make<never, Error>();
          disconnects.push(disconnected);
          let readNumber = 0;
          return {
            getConfig: Effect.sync(() => {
              reads.push(++readNumber);
              return serverConfig(`environment-${number}-config-${readNumber}`);
            }),
            subscribeShell: () =>
              Stream.fromEffect(
                Effect.sync(() => {
                  subscriptions.push(number);
                  return { kind: "synchronized" as const };
                }),
              ),
            subscribeVcsStatus: () =>
              Stream.fromEffect(
                Effect.sync(() => {
                  vcsSubscriptions.push(number);
                  return {
                    _tag: "remoteUpdated" as const,
                    remote: null,
                  };
                }),
              ),
            listRefs: () => Effect.die("not used"),
            switchRef: () => Effect.die("not used"),
            dispatchBootstrap: () => Effect.die("not used"),
            closed: Deferred.await(disconnected),
            close: Effect.sync(() => {
              closes.push(number);
            }),
          } satisfies ServerConfigConnection;
        }),
      );

      const first = yield* manager.getConfig;
      const refreshed = yield* manager.getConfig;
      expect(first.environment.environmentId).toBe("environment-1-config-1");
      expect(refreshed.environment.environmentId).toBe("environment-1-config-2");
      expect(connections).toEqual(["connection-1"]);
      expect(reads).toEqual([1, 2]);
      yield* manager.subscribeShell({ afterSequence: 4 }).pipe(Stream.runDrain);
      yield* manager.subscribeVcsStatus({ cwd: "/workspace" }).pipe(Stream.runDrain);
      expect(subscriptions).toEqual([1]);
      expect(vcsSubscriptions).toEqual([1]);

      yield* Deferred.fail(disconnects[0]!, new Error("socket closed"));
      yield* Effect.yieldNow;

      const reconnected = yield* manager.getConfig;
      expect(reconnected.environment.environmentId).toBe("environment-2-config-1");
      expect(connections).toEqual(["connection-1", "connection-2"]);
      expect(credentials).toEqual(["credential-1", "credential-2"]);
      expect(tickets).toEqual(["ticket-1", "ticket-2"]);
      yield* manager.subscribeShell({ afterSequence: 5 }).pipe(Stream.runDrain);
      yield* manager.subscribeVcsStatus({ cwd: "/workspace" }).pipe(Stream.runDrain);
      expect(subscriptions).toEqual([1, 2]);
      expect(vcsSubscriptions).toEqual([1, 2]);

      yield* manager.close;
      expect(closes).toEqual([1, 2]);

      const closedError = yield* manager.getConfig.pipe(Effect.flip);
      expect(closedError.kind).toBe("unavailable");
      expect(closedError.message).toBe("T3 transport is closed.");
      expect(connections).toEqual(["connection-1", "connection-2"]);
    }),
  );

  it.effect("becomes terminal before waiting for the retained connection to close", () =>
    Effect.gen(function* () {
      const closeStarted = yield* Deferred.make<void>();
      const releaseClose = yield* Deferred.make<void>();
      const connectionClosed = yield* Deferred.make<never, Error>();
      let connections = 0;
      const manager = yield* makeServerConfigConnectionManager(() =>
        Effect.sync(() => {
          connections += 1;
          return {
            getConfig: Effect.succeed(serverConfig("environment-a")),
            subscribeShell: () => Stream.never,
            subscribeVcsStatus: () => Stream.never,
            listRefs: () => Effect.die("not used"),
            switchRef: () => Effect.die("not used"),
            dispatchBootstrap: () => Effect.die("not used"),
            closed: Deferred.await(connectionClosed),
            close: Deferred.succeed(closeStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseClose)),
              Effect.andThen(Deferred.fail(connectionClosed, new Error("closed"))),
              Effect.asVoid,
            ),
          } satisfies ServerConfigConnection;
        }),
      );
      yield* manager.getConfig;

      const closing = yield* manager.close.pipe(Effect.forkChild);
      yield* Deferred.await(closeStarted);
      const readAfterCloseBegan = yield* manager.getConfig.pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.succeed(releaseClose, undefined);
      const error = yield* Fiber.join(readAfterCloseBegan);
      yield* Fiber.join(closing);

      expect(connections).toBe(1);
      expect(error.kind).toBe("unavailable");
    }),
  );

  it.effect("cancels a shared pending connection attempt during terminal close", () =>
    Effect.gen(function* () {
      const connectStarted = yield* Deferred.make<void>();
      const connectCancelled = yield* Deferred.make<void>();
      let connectionAttempts = 0;
      const manager = yield* makeServerConfigConnectionManager(() =>
        Effect.sync(() => {
          connectionAttempts += 1;
        }).pipe(
          Effect.andThen(Deferred.succeed(connectStarted, undefined)),
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(connectCancelled, undefined)),
        ),
      );

      const firstRead = yield* manager.getConfig.pipe(Effect.flip, Effect.forkChild);
      const secondRead = yield* manager.getConfig.pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(connectStarted);
      expect(connectionAttempts).toBe(1);

      yield* manager.close.pipe(Effect.timeout("1 second"));
      yield* Deferred.await(connectCancelled);
      const [firstError, secondError] = yield* Effect.all([
        Fiber.join(firstRead),
        Fiber.join(secondRead),
      ]);

      expect(firstError.kind).toBe("unavailable");
      expect(secondError.kind).toBe("unavailable");
      expect(connectionAttempts).toBe(1);
    }),
  );
});

describe("live T3 transport shutdown", () => {
  it.effect("rejects HTTP and WebSocket operations without reconnecting after close", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async () => {
        throw new Error("network access was not expected");
      });
      globalThis.fetch = fetchMock as typeof globalThis.fetch;
      let credentialReads = 0;
      const transport = yield* makeLiveT3Transport({
        httpBaseUrl: "https://t3.example",
        readBearerCredential: Effect.sync(() => {
          credentialReads += 1;
          return "credential";
        }),
      });

      yield* transport.close();
      const errors = yield* Effect.all([
        transport.validateSession().pipe(Effect.flip),
        transport.getShellSnapshot().pipe(Effect.flip),
        transport.getThreadSnapshot(null as never).pipe(Effect.flip),
        transport.dispatch({} as ClientOrchestrationCommand).pipe(Effect.flip),
        transport
          .subscribeShell({ requestCompletionMarker: true })
          .pipe(Stream.runDrain, Effect.flip),
        transport.subscribeVcsStatus({ cwd: "/workspace" }).pipe(Stream.runDrain, Effect.flip),
        transport.getServerConfig().pipe(Effect.flip),
        transport.listRefs(null as never).pipe(Effect.flip),
        transport.switchRef(null as never).pipe(Effect.flip),
        transport.dispatchBootstrap({} as ClientOrchestrationCommand).pipe(Effect.flip),
      ]);

      for (const error of errors) {
        expect(error.kind).toBe("unavailable");
        expect(error.message).toBe("T3 transport is closed.");
      }
      expect(credentialReads).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    }),
  );
});
