/**
 * A session with no user, such as a T3 Connect link to an environment with Entra sign-in on,
 * can sign in with Microsoft to take that user's role. The sign-in finishes in a browser; the
 * environment then closes this client's socket, and the reconnect reads the new session.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import type { Atom } from "effect/reactivity";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand } from "./runtime.ts";

const REQUEST_TIMEOUT_MS = 8_000;

export class EntraStepUpError extends Data.TaggedError("EntraStepUpError")<{
  readonly operation: "start" | "sign-out";
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.operation === "start"
      ? "Could not start Microsoft sign-in. Try again."
      : "Could not sign out. Try again.";
  }
}

/** What an authenticated request to the connected environment needs. */
const requestContext = Effect.fn("clientRuntime.state.entraStepUp.requestContext")(function* (
  operation: EntraStepUpError["operation"],
) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) {
    return yield* new EntraStepUpError({ operation, cause: "The environment is not connected." });
  }
  return {
    prepared: prepared.value,
    signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    ),
  };
});

/** Returns the Microsoft sign-in URL to open in a browser. */
export function createEntraStepUpCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return createEnvironmentCommand(runtime, {
    label: "environment-auth:entra-step-up",
    execute: () =>
      requestContext("start").pipe(
        Effect.flatMap((context) =>
          executeAuthenticatedEnvironmentHttpRequest({
            ...context,
            group: "auth",
            method: "POST",
            url: (urls) => urls.entraStepUp(),
            timeoutMs: REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) => client.entraStepUp({ headers }),
          }).pipe(Effect.mapError((cause) => new EntraStepUpError({ operation: "start", cause }))),
        ),
        Effect.map((result) => result.authorizationUrl),
      ),
  });
}

/** Drops the user from a stepped-up session; it keeps its own access. */
export function createEntraStepUpSignOutCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return createEnvironmentCommand(runtime, {
    label: "environment-auth:entra-step-up-sign-out",
    execute: () =>
      requestContext("sign-out").pipe(
        Effect.flatMap((context) =>
          executeAuthenticatedEnvironmentHttpRequest({
            ...context,
            group: "auth",
            method: "POST",
            url: (urls) => urls.signOut(),
            timeoutMs: REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) => client.signOut({ headers }),
          }).pipe(
            Effect.mapError((cause) => new EntraStepUpError({ operation: "sign-out", cause })),
          ),
        ),
      ),
  });
}
