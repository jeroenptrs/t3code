import { ClientCapabilities, PlatformConnectionSource } from "@t3tools/client-runtime/platform";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  Connectivity,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { managedRelayAccountChanges, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import Constants from "expo-constants";
import * as Network from "expo-network";
import { AppState } from "react-native";

import { authClientMetadata } from "../lib/authClientMetadata";
import * as Runtime from "../lib/runtime";
import * as TvDeviceId from "../persistence/device-id";
import { tvAtomRegistry } from "../state/atom-registry";
import * as ConnectionStorage from "./storage";

// Ported from apps/mobile/src/connection/platform.ts. Differences: no mobile-owned data
// (drafts, outbox) to clear on removal, and the device id comes from TvDeviceId.

// A resume after this long counts as a long suspension: the probe replaces a silent socket.
const LONG_BACKGROUND_AFTER_MS = 10_000;

function networkStatus(state: Network.NetworkState): "unknown" | "offline" | "online" {
  if (state.isConnected === false) return "offline";
  if (state.isConnected === true) return "online";
  return "unknown";
}

const layerConnectivity = Connectivity.layer({
  status: Effect.tryPromise({
    try: () => Network.getNetworkStateAsync(),
    catch: () => undefined,
  }).pipe(
    Effect.match({
      onFailure: () => "unknown" as const,
      onSuccess: networkStatus,
    }),
  ),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let active = true;
        const networkSubscription = Network.addNetworkStateListener((state) => {
          Queue.offerUnsafe(queue, networkStatus(state));
        });
        const appStateSubscription = AppState.addEventListener("change", (state) => {
          if (state !== "active") return;
          void Network.getNetworkStateAsync()
            .then((current) => {
              if (active) Queue.offerUnsafe(queue, networkStatus(current));
            })
            .catch(() => undefined);
        });
        return {
          close: () => {
            active = false;
            networkSubscription.remove();
            appStateSubscription.remove();
          },
        };
      }),
      ({ close }) => Effect.sync(close),
    ).pipe(Effect.asVoid),
  ),
});

/** Wake connections on network path changes; online/offline misses Wi-Fi-to-Ethernet moves. */
const networkPathChanges = Stream.callback<"network-changed">((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let active = true;
      let previous: Network.NetworkStateType | undefined;
      const record = (state: Network.NetworkState) => {
        const type = state.isConnected === true ? state.type : undefined;
        if (previous !== undefined && type !== undefined && type !== previous) {
          Queue.offerUnsafe(queue, "network-changed");
        }
        previous = type ?? previous;
      };
      void Network.getNetworkStateAsync()
        .then((state) => {
          if (active && previous === undefined && state.isConnected === true) {
            previous = state.type;
          }
        })
        .catch(() => undefined);
      const subscription = Network.addNetworkStateListener(record);
      return {
        remove: () => {
          active = false;
          subscription.remove();
        },
      };
    }),
    (subscription) => Effect.sync(() => subscription.remove()),
  ).pipe(Effect.asVoid),
);

const applicationActiveWakeups = Stream.callback<
  "application-active-probe" | "application-active-long"
>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let backgroundedAtMs = AppState.currentState === "background" ? Date.now() : null;
      return AppState.addEventListener("change", (state) => {
        if (state === "background") {
          backgroundedAtMs = Date.now();
          return;
        }
        if (state === "active") {
          const now = Date.now();
          Queue.offerUnsafe(
            queue,
            backgroundedAtMs !== null && now - backgroundedAtMs >= LONG_BACKGROUND_AFTER_MS
              ? "application-active-long"
              : "application-active-probe",
          );
          backgroundedAtMs = null;
        }
      });
    }),
    (subscription) => Effect.sync(() => subscription.remove()),
  ).pipe(Effect.asVoid),
);

const layerWakeups = Wakeups.layer({
  changes: Stream.mergeAll(
    [
      applicationActiveWakeups,
      managedRelayAccountChanges(tvAtomRegistry).pipe(
        Stream.map(() => "credentials-changed" as const),
      ),
      networkPathChanges,
    ],
    { concurrency: "unbounded" },
  ),
});

const unsupportedSsh = () =>
  Effect.fail(
    new ConnectionBlockedError({
      reason: "unsupported",
      detail: "SSH environments are only available in the desktop app.",
    }),
  );

const layerCapabilities = Layer.effectContext(
  Effect.gen(function* () {
    const deviceId = yield* TvDeviceId.TvDeviceId;
    return Context.make(
      ClientCapabilities.CloudSession,
      ClientCapabilities.CloudSession.of({
        identity: Effect.sync(() =>
          Option.fromNullishOr(tvAtomRegistry.get(managedRelaySessionAtom)),
        ),
        clerkToken: Effect.gen(function* () {
          const session = tvAtomRegistry.get(managedRelaySessionAtom);
          if (session === null) {
            return yield* new ConnectionBlockedError({
              reason: "authentication",
              detail: "Sign in to T3 Connect to connect this environment.",
            });
          }
          const token = yield* session.readClerkToken().pipe(
            Effect.mapError(
              (error) =>
                new ConnectionTransientError({
                  reason: "network",
                  detail: error.message,
                }),
            ),
          );
          if (token === null) {
            return yield* new ConnectionBlockedError({
              reason: "authentication",
              detail: "The T3 Connect session is unavailable.",
            });
          }
          return token;
        }),
      }),
    ).pipe(
      Context.add(
        ClientCapabilities.PrimaryEnvironmentAuth,
        ClientCapabilities.PrimaryEnvironmentAuth.of({
          bearerToken: Effect.succeed(Option.none()),
        }),
      ),
      Context.add(ClientCapabilities.AnalyticsDevice, {
        id: deviceId.loadOrCreate.pipe(Effect.option),
      }),
      Context.add(
        ClientCapabilities.RelayDeviceIdentity,
        ClientCapabilities.RelayDeviceIdentity.of({
          deviceId: deviceId.loadOrCreate.pipe(
            Effect.mapError(
              (cause) =>
                new ConnectionTransientError({
                  reason: "remote-unavailable",
                  detail: `Could not load the TV device identity: ${String(cause)}`,
                }),
            ),
            Effect.map(Option.some),
          ),
        }),
      ),
      Context.add(
        ClientCapabilities.ClientPresentation,
        ClientCapabilities.ClientPresentation.of({
          metadata: authClientMetadata(Constants.expoConfig?.version),
        }),
      ),
      Context.add(
        ClientCapabilities.SshEnvironmentGateway,
        ClientCapabilities.SshEnvironmentGateway.of({
          provision: unsupportedSsh,
          prepare: unsupportedSsh,
          disconnect: () => Effect.void,
        }),
      ),
    );
  }),
);

const layerPlatformConnectionSource = Layer.succeed(
  PlatformConnectionSource.PlatformConnectionSource,
  PlatformConnectionSource.PlatformConnectionSource.of({
    registrations: Stream.empty,
  }),
);

const layerProvidedConnectionStorage = ConnectionStorage.layer.pipe(Layer.provide(Runtime.layer));
const layerProvidedCapabilities = layerCapabilities.pipe(Layer.provide(Runtime.layer));

type ConnectionPlatformLayerSource =
  | typeof layerProvidedConnectionStorage
  | typeof Runtime.layer
  | typeof layerConnectivity
  | typeof layerWakeups
  | typeof layerProvidedCapabilities
  | typeof layerPlatformConnectionSource;

export const layer: Layer.Layer<
  Layer.Success<ConnectionPlatformLayerSource>,
  Layer.Error<ConnectionPlatformLayerSource>,
  Layer.Services<ConnectionPlatformLayerSource>
> = Layer.mergeAll(
  layerProvidedConnectionStorage,
  Runtime.layer,
  layerConnectivity,
  layerWakeups,
  layerProvidedCapabilities,
  layerPlatformConnectionSource,
);
