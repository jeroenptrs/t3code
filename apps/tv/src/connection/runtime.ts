import { Connection } from "@t3tools/client-runtime/connection";
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import {
  BoundedThreadSnapshotLoader,
  ThreadHistoryController,
} from "@t3tools/client-runtime/state/threads";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";

import * as Runtime from "../lib/runtime";
import * as ConnectionPlatform from "./platform";

// Mirrors apps/mobile/src/connection/runtime.ts without pull request diffs, background
// activity reporting, or the HMR layer swap.

const layerSnapshotLoader = Layer.mergeAll(
  BoundedThreadSnapshotLoader.layer,
  ShellSnapshotLoader.layer,
  ThreadHistoryController.layer,
);

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof layerSnapshotLoader
  | typeof Runtime.layer
  | typeof ConnectionPlatform.layer;

const layerConnection = layerSnapshotLoader.pipe(
  Layer.provideMerge(Connection.layer),
  Layer.provideMerge(
    Layer.merge(Runtime.layer, ConnectionPlatform.layer.pipe(Layer.provide(Runtime.layer))),
  ),
);

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.runtime(layerConnection);
