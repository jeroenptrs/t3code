import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { ManagedRelay, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import {
  createRuntimeCommand,
  reportAtomCommandResult,
  runAtomCommand,
  settleAsyncResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { runtime } from "../lib/runtime";
import { tvAtomRegistry } from "../state/atom-registry";
import { connectionAtomRuntime } from "./runtime";

/**
 * What the cloud sign-in hands the connection runtime. `readClerkToken` returns a Clerk
 * session JWT for the relay's `t3-relay` audience, or null when signed out.
 */
export interface TvCloudSessionInput {
  readonly accountId: string;
  readonly readClerkToken: () => Promise<string | null>;
}

/**
 * Installs or clears the T3 Connect session. Until something calls this, the app has no cloud
 * session: relay environments report "sign in", and directly paired environments work.
 * Calling it again for the same account swaps the token reader without reconnecting.
 */
export function setTvCloudSession(input: TvCloudSessionInput | null): void {
  setManagedRelaySession(tvAtomRegistry, input);
}

const removeRelayEnvironments = createRuntimeCommand(connectionAtomRuntime, {
  label: "tv:cloud:remove-relay-environments",
  execute: (_input: void) =>
    EnvironmentRegistry.EnvironmentRegistry.pipe(
      Effect.flatMap((registry) => registry.removeRelayEnvironments()),
    ),
});

/**
 * Forgets what a signed-out account left on this TV: its saved relay environments and the
 * cached relay access tokens. Mobile also archives drafts here; the TV has none.
 */
export async function cleanUpTvCloudAccount(): Promise<void> {
  const removal = await runAtomCommand(tvAtomRegistry, removeRelayEnvironments, undefined, {
    reportFailure: false,
    reportDefect: false,
  });
  if (removal._tag !== "Success") throw squashAtomCommandFailure(removal);
  const reset = await settleAsyncResult(() =>
    runtime.runPromiseExit(
      ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
    ),
  );
  reportAtomCommandResult(reset, { label: "tv cloud account cleanup" });
}
