import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadStateAtoms,
  createThreadEnvironmentAtoms,
} from "@t3tools/client-runtime/state/threads";

import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentSnapshotAtom } from "../../state/environments";

// The thread atoms apps/mobile/src/state/threads.ts wires up, for one open thread: its live
// projection (snapshot plus stream) and the thread commands, startTurn among them.

export const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);

export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);

export const threadCommands = createThreadEnvironmentAtoms(
  connectionAtomRuntime,
  environmentSnapshotAtom,
);
