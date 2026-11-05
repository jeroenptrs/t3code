import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as FleetBroker from "./FleetBroker.ts";
import * as FleetServiceLayer from "./FleetServiceLayer.ts";
import * as HomeService from "./HomeService.ts";

/** Home and fleet services, shared by the WebSocket and MCP transports. */
export const HomeLayer = Layer.mergeAll(
  HomeService.layer,
  FleetBroker.layer,
  FleetServiceLayer.layer.pipe(
    Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
  ),
);
