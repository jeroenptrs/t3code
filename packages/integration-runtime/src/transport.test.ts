import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeServerConfigConnectionManager, type ServerConfigConnection } from "./transport.ts";

const serverConfig = (environmentId: string): ServerConfig =>
  ({ environment: { environmentId: EnvironmentId.make(environmentId) } }) as ServerConfig;

describe("server config connection manager", () => {
  it.effect("reads live config on the retained session and reconnects after closure", () =>
    Effect.gen(function* () {
      const connections: Array<string> = [];
      const reads: Array<number> = [];
      const disconnects: Array<Deferred.Deferred<never, Error>> = [];
      let connectionNumber = 0;

      const manager = yield* makeServerConfigConnectionManager(() =>
        Effect.gen(function* () {
          const number = ++connectionNumber;
          connections.push(`connection-${number}`);
          const disconnected = yield* Deferred.make<never, Error>();
          disconnects.push(disconnected);
          let readNumber = 0;
          return {
            getConfig: Effect.sync(() => {
              reads.push(++readNumber);
              return serverConfig(`environment-${number}-config-${readNumber}`);
            }),
            listRefs: () => Effect.die("not used"),
            switchRef: () => Effect.die("not used"),
            dispatchBootstrap: () => Effect.die("not used"),
            closed: Deferred.await(disconnected),
            close: Effect.void,
          } satisfies ServerConfigConnection;
        }),
      );

      const first = yield* manager.getConfig;
      const refreshed = yield* manager.getConfig;
      expect(first.environment.environmentId).toBe("environment-1-config-1");
      expect(refreshed.environment.environmentId).toBe("environment-1-config-2");
      expect(connections).toEqual(["connection-1"]);
      expect(reads).toEqual([1, 2]);

      yield* Deferred.fail(disconnects[0]!, new Error("socket closed"));
      yield* Effect.yieldNow;

      const reconnected = yield* manager.getConfig;
      expect(reconnected.environment.environmentId).toBe("environment-2-config-1");
      expect(connections).toEqual(["connection-1", "connection-2"]);
    }),
  );
});
