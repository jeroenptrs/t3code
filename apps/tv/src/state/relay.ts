import {
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { createRelayEnvironmentDiscoveryAtoms } from "@t3tools/client-runtime/state/relay";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { tvAtomRegistry } from "./atom-registry";
import { environmentCatalog } from "./environments";

// Same atoms as apps/mobile/src/state/relay.ts. The discovery service lives in the connection
// runtime: it lists GET /v1/environments with the signed-in account's relay token, then checks
// each environment's status, and refreshes itself when the cloud session changes.
export const relayEnvironmentDiscovery =
  createRelayEnvironmentDiscoveryAtoms(connectionAtomRuntime);

export function refreshRelayEnvironments(): void {
  void runAtomCommand(tvAtomRegistry, relayEnvironmentDiscovery.refresh, undefined, {
    reportFailure: false,
  });
}

/**
 * Saves a T3 Connect environment as a relay connection, as mobile's connectRelayEnvironment.
 * Returns an error message, or null once the catalog has the environment.
 */
export async function registerRelayEnvironment(
  environment: RelayClientEnvironmentRecord,
): Promise<string | null> {
  const result = await runAtomCommand(
    tvAtomRegistry,
    environmentCatalog.register,
    new RelayConnectionRegistration({
      target: new RelayConnectionTarget({
        environmentId: environment.environmentId,
        label: environment.label,
      }),
    }),
    { reportFailure: false },
  );
  if (AsyncResult.isSuccess(result)) return null;
  const error = Cause.squash(result.cause);
  return error instanceof Error ? error.message : "Could not add the environment.";
}
