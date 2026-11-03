/**
 * Fork-only. Portal user administration on whichever environment is the portal, over the same
 * authenticated HTTP path as the session read, so it works direct, relayed, or same-origin.
 */
import {
  EnvironmentUserAccessConflictError,
  type AuthUserId,
  type AuthUserRole,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import type { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand } from "./runtime.ts";

const REQUEST_TIMEOUT_MS = 8_000;

export class PortalUnavailableError extends Data.TaggedError("PortalUnavailableError")<{}> {
  override get message(): string {
    return "The portal is not connected.";
  }
}

export type PortalUserMutation =
  | { readonly type: "approve"; readonly userId: AuthUserId; readonly role: AuthUserRole }
  | { readonly type: "change-role"; readonly userId: AuthUserId; readonly role: AuthUserRole }
  | { readonly type: "disable"; readonly userId: AuthUserId }
  | { readonly type: "enable"; readonly userId: AuthUserId; readonly role?: AuthUserRole };

const isConflictError = Schema.is(EnvironmentUserAccessConflictError);

/** The shared request path keeps only common errors, so the conflict travels out as a value. */
class Refused {
  readonly conflict: EnvironmentUserAccessConflictError;
  constructor(conflict: EnvironmentUserAccessConflictError) {
    this.conflict = conflict;
  }
}

type AuthRequest = Parameters<
  typeof executeAuthenticatedEnvironmentHttpRequest<"auth", unknown, unknown, unknown>
>[0];

const authRequest = Effect.fn("clientRuntime.state.portalUsers.request")(function* <A, E, R>(
  method: AuthRequest["method"],
  url: AuthRequest["url"],
  request: (input: Parameters<AuthRequest["request"]>[0]) => Effect.Effect<A, E, R>,
) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) return yield* new PortalUnavailableError();
  const result = yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: prepared.value,
    signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    ),
    group: "auth",
    method,
    url,
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: (input) =>
      request(input).pipe(
        Effect.catchIf(isConflictError, (conflict) => Effect.succeed(new Refused(conflict))),
      ),
  });
  return result instanceof Refused ? yield* result.conflict : result;
});

export function createPortalUserCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  const list = createEnvironmentCommand(runtime, {
    label: "portal-users:list",
    execute: () =>
      authRequest(
        "GET",
        (urls) => urls.users(),
        ({ client, headers }) => client.users({ headers }),
      ),
  });

  const accessChanges = createEnvironmentCommand(runtime, {
    label: "portal-users:access-changes",
    execute: (userId: AuthUserId) =>
      authRequest(
        "GET",
        (urls) => urls.userAccessChanges({ query: { userId } }),
        ({ client, headers }) => client.userAccessChanges({ headers, query: { userId } }),
      ),
  });

  const mutate = createEnvironmentCommand(runtime, {
    label: "portal-users:mutate",
    execute: (mutation: PortalUserMutation) => {
      const { userId } = mutation;
      switch (mutation.type) {
        case "approve":
          return authRequest(
            "POST",
            (urls) => urls.approveUser(),
            ({ client, headers }) =>
              client.approveUser({ headers, payload: { userId, role: mutation.role } }),
          );
        case "change-role":
          return authRequest(
            "POST",
            (urls) => urls.changeUserRole(),
            ({ client, headers }) =>
              client.changeUserRole({ headers, payload: { userId, role: mutation.role } }),
          );
        case "disable":
          return authRequest(
            "POST",
            (urls) => urls.disableUser(),
            ({ client, headers }) => client.disableUser({ headers, payload: { userId } }),
          );
        case "enable":
          return authRequest(
            "POST",
            (urls) => urls.enableUser(),
            ({ client, headers }) =>
              client.enableUser({
                headers,
                payload: { userId, ...(mutation.role ? { role: mutation.role } : {}) },
              }),
          );
      }
    },
  });

  const revokeSessions = createEnvironmentCommand(runtime, {
    label: "portal-users:revoke-sessions",
    execute: (userId: AuthUserId) =>
      authRequest(
        "POST",
        (urls) => urls.revokeUserSessions(),
        ({ client, headers }) => client.revokeUserSessions({ headers, payload: { userId } }),
      ).pipe(Effect.map((result) => result.revokedCount)),
  });

  return { list, accessChanges, mutate, revokeSessions };
}
