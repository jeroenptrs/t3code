import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Socket from "effect/socket/Socket";

import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";

import { configuredRelayUrl } from "../config";
import * as Persistence from "../persistence/layer";
import * as Dpop from "../relay/dpop";
import * as ManagedRelayLayer from "../relay/managedRelayLayer";

// Mirrors apps/mobile/src/lib/runtime.ts without tracing and the protected-data gate,
// which exists for locked iOS background launches. tvOS has neither.

const layerHttpClient = layerRemoteHttpClient(fetch);

type RuntimeLayerSource =
  | ReturnType<typeof ManagedRelayLayer.layer>
  | typeof Socket.layerWebSocketConstructorGlobal
  | typeof Dpop.layer
  | typeof layerHttpClient
  | typeof Persistence.layer;

const layerRuntime = Layer.merge(
  ManagedRelayLayer.layer(configuredRelayUrl()),
  Socket.layerWebSocketConstructorGlobal,
).pipe(
  Layer.provideMerge(Dpop.layer),
  Layer.provideMerge(layerHttpClient),
  Layer.provideMerge(Persistence.layer),
);

export const runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = ManagedRuntime.make(layerRuntime);

export const layer: Layer.Layer<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = Layer.effectContext(runtime.contextEffect);
