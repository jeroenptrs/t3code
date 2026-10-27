import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";

import { tvAtomRegistry } from "../state/atom-registry";
import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairingUrl = createRuntimeCommand(connectionAtomRuntime, {
  label: "tv:connection:connect-pairing-url",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: { readonly pairingUrl: string }) => input.pairingUrl,
  },
  execute: (input: { readonly pairingUrl: string }) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerPairing(input)),
    ),
});

export interface PairingOutcome {
  readonly ok: boolean;
  readonly error: string | null;
}

/** Pairs with the environment behind a pairing URL and saves it, as mobile's pairEnvironment. */
export async function pairEnvironment(pairingUrl: string): Promise<PairingOutcome> {
  const result = await runAtomCommand(
    tvAtomRegistry,
    connectPairingUrl,
    { pairingUrl },
    { reportFailure: false },
  );
  if (AsyncResult.isSuccess(result)) return { ok: true, error: null };
  const error = Cause.squash(result.cause);
  return {
    ok: false,
    error: error instanceof Error ? error.message : "Failed to pair with the environment.",
  };
}
