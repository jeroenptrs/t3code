import * as Layer from "effect/Layer";

import * as EnvironmentCacheStore from "../connection/environment-cache-store";
import * as TvDatabase from "./database";
import * as TvDeviceId from "./device-id";
import * as TvSecureStorage from "./secure-storage";

const layerBase = Layer.merge(TvDatabase.layer, TvSecureStorage.layer);
const layerDependent = Layer.merge(TvDeviceId.layer, EnvironmentCacheStore.layer).pipe(
  Layer.provide(layerBase),
);

export const layer = Layer.merge(layerBase, layerDependent);
