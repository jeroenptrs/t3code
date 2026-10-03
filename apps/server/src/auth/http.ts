import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthReviewWriteScope,
  AuthTerminalOperateScope,
  EnvironmentAuthInvalidError,
  type EnvironmentAuthInvalidReason,
  EnvironmentHttpApi,
  EnvironmentInternalError,
  type EnvironmentInternalErrorReason,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  type EnvironmentRequestInvalidReason,
  EnvironmentResourceNotFoundError,
  type EnvironmentResourceNotFoundReason,
  EnvironmentScopeRequiredError,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  ENTRA_SIGN_IN_ERROR_PARAM,
  ENTRA_SIGN_IN_RETURN_TO_PARAM,
  ENTRA_SIGN_IN_START_PATH,
  EnvironmentUserAccessConflictError,
  type EnvironmentUserAccessConflictReason,
} from "@t3tools/contracts";
import type {
  AuthEnvironmentScope,
  AuthUserAccessActor,
  AuthUserId,
  DpopFailureReason,
} from "@t3tools/contracts";
import { parseAllowedOAuthScope } from "@t3tools/shared/oauthScope";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Cookies from "effect/unstable/http/Cookies";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as EntraSignIn from "./EntraSignIn.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as SessionStore from "./SessionStore.ts";
import * as UserRegistry from "./UserRegistry.ts";
import { traceAuthenticatedRelayRequest, traceRelayRequest } from "../cloud/traceRelayRequest.ts";
import { deriveAuthClientMetadata } from "./utils.ts";
import { verifyRequestDpopProof } from "./dpop.ts";

const CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const appendCredentialResponseHeaders = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeaders(response, CREDENTIAL_RESPONSE_HEADERS)),
);

const appendDpopChallengeHeader = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", "DPoP")),
);

const appendDpopChallengeOnUnauthorized = (error: EnvironmentAuthInvalidError) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const usesDpop =
      (request.originalUrl.startsWith("/oauth/token") && request.headers.dpop !== undefined) ||
      request.headers.authorization?.startsWith("DPoP ") === true;
    if (usesDpop) {
      yield* appendDpopChallengeHeader;
    }
    return yield* error;
  });

const currentEnvironmentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
);

export function annotateEnvironmentRequest(endpoint: string) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const traceId = yield* currentEnvironmentTraceId;

    yield* Effect.addFinalizer((exit) =>
      exit._tag === "Failure"
        ? Effect.logWarning("environment api request failed", {
            endpoint,
            traceId,
            errorTag: causeErrorTag(exit.cause),
            cause: exit.cause,
          })
        : Effect.void,
    );
    yield* Effect.annotateLogsScoped({ "environment.endpoint": endpoint, traceId });
    yield* Effect.annotateCurrentSpan({
      "environment.endpoint": endpoint,
      "http.request.method": request.method,
      "url.path": url._tag === "Some" ? url.value.pathname : "unknown",
    });
  });
}

export function failEnvironmentAuthInvalid(
  reason: EnvironmentAuthInvalidReason,
  dpopFailureReason?: DpopFailureReason,
) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentAuthInvalidError({
          code: "auth_invalid",
          reason,
          ...(dpopFailureReason === undefined ? {} : { dpopFailureReason }),
          traceId,
        }),
      ),
    ),
  );
}

export function failEnvironmentInvalidRequest(reason: EnvironmentRequestInvalidReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentRequestInvalidError({ code: "invalid_request", reason, traceId })),
    ),
  );
}

export function failEnvironmentScopeRequired(requiredScope: AuthEnvironmentScope) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentScopeRequiredError({
          code: "insufficient_scope",
          requiredScope,
          traceId,
        }),
      ),
    ),
  );
}

function failEnvironmentOperationForbidden(
  reason: "current_session_revoke_not_allowed" | "user_session_required" | "host_cli_required",
) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentOperationForbiddenError({
          code: "operation_forbidden",
          reason,
          traceId,
        }),
      ),
    ),
  );
}

export function failEnvironmentNotFound(reason: EnvironmentResourceNotFoundReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentResourceNotFoundError({ code: "not_found", reason, traceId })),
    ),
  );
}

function failUserAccessConflict(reason: EnvironmentUserAccessConflictReason, userId: AuthUserId) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentUserAccessConflictError({
          code: "user_access_conflict",
          reason,
          userId,
          traceId,
        }),
      ),
    ),
  );
}

export function failEnvironmentInternal(reason: EnvironmentInternalErrorReason, error?: unknown) {
  return Effect.gen(function* () {
    const traceId = yield* currentEnvironmentTraceId;
    if (error !== undefined) {
      yield* Effect.logError("environment api operation failed", {
        reason,
        traceId,
        cause: error,
      });
    }
    return yield* new EnvironmentInternalError({ code: "internal_error", reason, traceId });
  });
}

const appendSessionCookie = (cookieName: string, token: string, expiresAt: DateTime.DateTime) =>
  Effect.fromResult(
    Cookies.set(Cookies.empty, cookieName, token, {
      expires: DateTime.toDate(expiresAt),
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    }),
  ).pipe(
    Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")),
    Effect.flatMap((cookies) =>
      HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.mergeCookies(response, cookies)),
      ),
    ),
  );

export const requireEnvironmentScope = Effect.fn("environment.auth.requireScope")(function* (
  scope: AuthEnvironmentScope,
) {
  const session = yield* EnvironmentAuthenticatedPrincipal;
  if (!session.scopes.has(scope)) {
    return yield* failEnvironmentScopeRequired(scope);
  }
  return session;
});

/**
 * Changing a user's access needs `access:write` and a session that is itself a
 * user, so the audit log names the administrator who made the change.
 */
const requireUserAdministrator = Effect.gen(function* () {
  const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
  if (session.userId === undefined) {
    return yield* failEnvironmentOperationForbidden("user_session_required");
  }
  return { type: "user", userId: session.userId } satisfies AuthUserAccessActor;
});

type UserAccessChangeError =
  | UserRegistry.AuthUserNotFoundError
  | UserRegistry.AuthUserTransitionError
  | UserRegistry.AuthUserRoleRequiredError
  | UserRegistry.LastAdministratorError
  | UserRegistry.UserRegistryPersistenceError;

const mapUserAccessErrors = <A>(effect: Effect.Effect<A, UserAccessChangeError>) =>
  effect.pipe(
    Effect.catchTags({
      AuthUserNotFoundError: () => failEnvironmentNotFound("user_not_found"),
      AuthUserTransitionError: (error: UserRegistry.AuthUserTransitionError) =>
        failUserAccessConflict("invalid_transition", error.userId),
      AuthUserRoleRequiredError: (error: UserRegistry.AuthUserRoleRequiredError) =>
        failUserAccessConflict("role_required", error.userId),
      LastAdministratorError: (error: UserRegistry.LastAdministratorError) =>
        failUserAccessConflict("last_administrator", error.userId),
      UserRegistryPersistenceError: (error: UserRegistry.UserRegistryPersistenceError) =>
        failEnvironmentInternal("user_access_change_failed", error),
    }),
  );

const expireSessionCookie = (cookieName: string) =>
  Effect.fromResult(
    Cookies.expireCookie(Cookies.empty, cookieName, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    }),
  ).pipe(
    Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")),
    Effect.flatMap((cookies) =>
      HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.mergeCookies(response, cookies)),
      ),
    ),
  );

export const environmentAuthenticatedAuthLayer = Layer.effect(
  EnvironmentAuthenticatedAuth,
  Effect.gen(function* () {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        return yield* httpEffect.pipe(
          Effect.provideService(EnvironmentAuthenticatedPrincipal, {
            ...session,
            scopes: new Set(session.scopes),
          }),
          session.subject === "cloud-connect" ? traceAuthenticatedRelayRequest : identity,
        );
      }).pipe(Effect.catchTag("EnvironmentAuthInvalidError", appendDpopChallengeOnUnauthorized));
  }),
);

export const authHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "auth",
  Effect.fnUntraced(function* (handlers) {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const users = yield* UserRegistry.UserRegistry;

    return handlers
      .handle(
        "session",
        Effect.fn("environment.auth.session")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const result = yield* serverAuth.getSessionState(request);
            const credential = EnvironmentAuth.selectRequestCredential(
              request,
              sessions.cookieName,
              sessions.legacyCookieName,
            );
            if (
              credential?.source === "legacy-cookie" &&
              result.authenticated &&
              result.sessionMethod === "browser-session-cookie" &&
              result.expiresAt
            ) {
              yield* appendSessionCookie(sessions.cookieName, credential.token, result.expiresAt);
              yield* appendCredentialResponseHeaders;
            }
            return result;
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        ),
      )
      .handle(
        "browserSession",
        Effect.fn("environment.auth.browserSession")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const result = yield* serverAuth.createBrowserSession(
              args.payload.credential,
              deriveAuthClientMetadata({ request }),
            );
            const cookieName = result.cookieName ?? sessions.cookieName;
            const selectedCookie = yield* Effect.fromResult(
              Cookies.set(Cookies.empty, cookieName, result.sessionToken, {
                expires: DateTime.toDate(result.response.expiresAt),
                httpOnly: true,
                path: "/",
                sameSite: "lax",
              }),
            ).pipe(Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")));
            const sessionCookies = result.expireNormalCookie
              ? yield* Effect.fromResult(
                  Cookies.expireCookie(selectedCookie, sessions.cookieName, {
                    httpOnly: true,
                    path: "/",
                    sameSite: "lax",
                  }),
                ).pipe(Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")))
              : selectedCookie;

            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(HttpServerResponse.mergeCookies(response, sessionCookies)),
            );
            yield* appendCredentialResponseHeaders;
            return result.response;
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("browser_session_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "token",
        Effect.fn("environment.auth.token")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const requestedScopes =
              args.payload.scope === undefined
                ? undefined
                : parseAllowedOAuthScope({
                    value: args.payload.scope,
                    allowedScopes: new Set<AuthEnvironmentScope>([
                      AuthOrchestrationReadScope,
                      AuthOrchestrationOperateScope,
                      AuthTerminalOperateScope,
                      AuthReviewWriteScope,
                      AuthAccessReadScope,
                      AuthAccessWriteScope,
                      AuthRelayReadScope,
                      AuthRelayWriteScope,
                    ]),
                  });
            if (requestedScopes === null) {
              return yield* failEnvironmentInvalidRequest("invalid_scope");
            }
            const proofKeyThumbprint = args.headers.dpop
              ? yield* verifyRequestDpopProof({ request }).pipe(
                  Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
                    appendDpopChallengeHeader.pipe(
                      Effect.andThen(
                        failEnvironmentAuthInvalid(
                          "invalid_credential",
                          EnvironmentAuth.serverAuthDpopFailureReason(error),
                        ),
                      ),
                    ),
                  ),
                  Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
                    failEnvironmentInternal("access_token_issuance_failed", error),
                  ),
                )
              : undefined;
            yield* appendCredentialResponseHeaders;
            return yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
              args.payload.subject_token,
              requestedScopes,
              deriveAuthClientMetadata({
                request,
                presented: {
                  ...(args.payload.client_label ? { label: args.payload.client_label } : {}),
                  ...(args.payload.client_device_type
                    ? { deviceType: args.payload.client_device_type }
                    : {}),
                  ...(args.payload.client_os ? { os: args.payload.client_os } : {}),
                },
              }),
              proofKeyThumbprint ? { proofKeyThumbprint } : undefined,
            );
          },
          traceRelayRequest,
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInvalidRequestError, (error) =>
            failEnvironmentInvalidRequest(EnvironmentAuth.serverAuthInvalidRequestReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("access_token_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "webSocketTicket",
        Effect.fn("environment.auth.webSocketTicket")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            yield* appendCredentialResponseHeaders;
            return yield* serverAuth.issueWebSocketTicket(session);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("websocket_ticket_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "pairingCredential",
        Effect.fn("environment.auth.pairingCredential")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            // A pairing credential becomes a service token that is not bound to
            // the user who minted it and would outlive their access. With Entra
            // on, a signed-in user cannot mint one; service sessions, which then
            // descend only from the host CLI, still can (Slack's rotator does).
            if (
              session.userId !== undefined &&
              (yield* serverAuth.getDescriptor()).entraSignIn === true
            ) {
              return yield* failEnvironmentOperationForbidden("host_cli_required");
            }
            const delegatedScopes = args.payload.scopes ?? AuthStandardClientScopes;
            if (
              delegatedScopes.length === 0 ||
              new Set<AuthEnvironmentScope>(delegatedScopes).size !== delegatedScopes.length
            ) {
              return yield* failEnvironmentInvalidRequest("invalid_scope");
            }
            for (const delegatedScope of delegatedScopes) {
              if (!session.scopes.has(delegatedScope)) {
                return yield* failEnvironmentScopeRequired(delegatedScope);
              }
            }
            return yield* serverAuth.issuePairingCredential(args.payload);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_credential_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "pairingLinks",
        Effect.fn("environment.auth.pairingLinks")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessReadScope);
            return yield* serverAuth.listPairingLinks();
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_links_load_failed", error),
          ),
        ),
      )
      .handle(
        "revokePairingLink",
        Effect.fn("environment.auth.revokePairingLink")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revoked = yield* serverAuth.revokePairingLink(args.payload.id);
            return { revoked };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_link_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "clients",
        Effect.fn("environment.auth.clients")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessReadScope);
            return yield* serverAuth.listClientSessions(session.sessionId);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_sessions_load_failed", error),
          ),
        ),
      )
      .handle(
        "revokeClient",
        Effect.fn("environment.auth.revokeClient")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revoked = yield* serverAuth.revokeClientSession(
              session.sessionId,
              args.payload.sessionId,
            );
            return { revoked };
          },
          Effect.catchTag("ServerAuthForbiddenOperationError", () =>
            failEnvironmentOperationForbidden("current_session_revoke_not_allowed"),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_session_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "revokeOtherClients",
        Effect.fn("environment.auth.revokeOtherClients")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revokedCount = yield* serverAuth.revokeOtherClientSessions(session.sessionId);
            return { revokedCount };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_session_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "signOut",
        Effect.fn("environment.auth.signOut")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const result = yield* serverAuth.signOut(request);
            for (const cookieName of result.cookieNames) {
              yield* expireSessionCookie(cookieName);
            }
            yield* appendCredentialResponseHeaders;
            return { signedOut: result.signedOut };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("sign_out_failed", error),
          ),
        ),
      )
      .handle(
        "users",
        Effect.fn("environment.auth.users")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessReadScope);
            return yield* users.list();
          },
          Effect.catchTag("UserRegistryPersistenceError", (error) =>
            failEnvironmentInternal("users_load_failed", error),
          ),
        ),
      )
      .handle(
        "userAccessChanges",
        Effect.fn("environment.auth.userAccessChanges")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessReadScope);
            return yield* users.listAccessChanges(args.query);
          },
          Effect.catchTag("UserRegistryPersistenceError", (error) =>
            failEnvironmentInternal("users_load_failed", error),
          ),
        ),
      )
      .handle(
        "approveUser",
        Effect.fn("environment.auth.approveUser")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const actor = yield* requireUserAdministrator;
          return yield* mapUserAccessErrors(users.approve({ ...args.payload, actor }));
        }),
      )
      .handle(
        "changeUserRole",
        Effect.fn("environment.auth.changeUserRole")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const actor = yield* requireUserAdministrator;
          return yield* mapUserAccessErrors(users.changeRole({ ...args.payload, actor }));
        }),
      )
      .handle(
        "disableUser",
        Effect.fn("environment.auth.disableUser")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const actor = yield* requireUserAdministrator;
          return yield* mapUserAccessErrors(users.disable({ ...args.payload, actor }));
        }),
      )
      .handle(
        "enableUser",
        Effect.fn("environment.auth.enableUser")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const actor = yield* requireUserAdministrator;
          return yield* mapUserAccessErrors(users.enable({ ...args.payload, actor }));
        }),
      )
      .handle(
        "revokeUserSessions",
        Effect.fn("environment.auth.revokeUserSessions")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireUserAdministrator;
            const revokedCount = yield* serverAuth.revokeUserSessions(args.payload.userId);
            return { revokedCount };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("user_sessions_revoke_failed", error),
          ),
        ),
      );
  }),
);

const ENTRA_NO_STORE_HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

/** Redirects the browser to Entra. 404 when Entra sign-in is not configured. */
const entraSignInStartRoute = HttpRouter.add(
  "GET",
  ENTRA_SIGN_IN_START_PATH,
  Effect.gen(function* () {
    const entra = yield* EntraSignIn.EntraSignIn;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const started = yield* entra.start({
      returnTo: Option.isSome(url)
        ? url.value.searchParams.get(ENTRA_SIGN_IN_RETURN_TO_PARAM)
        : null,
    });
    return yield* HttpServerResponse.redirect(started.authorizationUrl, {
      headers: ENTRA_NO_STORE_HEADERS,
    }).pipe(
      HttpServerResponse.setCookie(entra.flowCookieName, started.flowCookie, {
        httpOnly: true,
        secure: entra.secureCookies,
        sameSite: "lax",
        path: entra.callbackPath,
        maxAge: started.flowCookieMaxAge,
      }),
    );
  }).pipe(
    Effect.catchTag("EntraSignInDisabledError", () =>
      Effect.succeed(HttpServerResponse.text("Not Found", { status: 404 })),
    ),
    Effect.catchTag("CookiesError", () =>
      Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
    ),
  ),
);

/**
 * Finishes sign-in: sets the session cookie and returns to the requested
 * page, or lands on `/?signInError=<reason>` when anything fails.
 */
const handleEntraSignInCallback = (entra: EntraSignIn.EntraSignIn["Service"]) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = Option.match(HttpServerRequest.toURL(request), {
      onNone: () => new URLSearchParams(),
      onSome: (url) => url.searchParams,
    });
    const result = yield* entra
      .complete({
        code: params.get("code"),
        state: params.get("state"),
        error: params.get("error"),
        flowCookie: request.cookies[entra.flowCookieName],
        client: deriveAuthClientMetadata({ request }),
      })
      .pipe(Effect.result);
    if (Result.isFailure(result)) {
      const reason =
        result.failure._tag === "EntraSignInError" ? result.failure.reason : "internal_error";
      yield* Effect.logWarning("Entra sign-in failed.", {
        reason,
        detail: result.failure.message,
        ...(result.failure._tag === "EntraSignInError" ? { cause: result.failure.detail } : {}),
      });
      if (result.failure._tag === "EntraSignInDisabledError") {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
    }
    const response = Result.isSuccess(result)
      ? yield* HttpServerResponse.redirect(result.success.returnTo, {
          headers: ENTRA_NO_STORE_HEADERS,
        }).pipe(
          HttpServerResponse.setCookie(sessions.cookieName, result.success.session.token, {
            httpOnly: true,
            secure: entra.secureCookies,
            sameSite: "lax",
            path: "/",
            expires: DateTime.toDate(result.success.session.expiresAt),
          }),
        )
      : HttpServerResponse.redirect(
          `/?${new URLSearchParams({
            [ENTRA_SIGN_IN_ERROR_PARAM]:
              result.failure._tag === "EntraSignInError" ? result.failure.reason : "internal_error",
          }).toString()}`,
          { headers: ENTRA_NO_STORE_HEADERS },
        );
    return yield* HttpServerResponse.expireCookie(response, entra.flowCookieName, {
      httpOnly: true,
      secure: entra.secureCookies,
      sameSite: "lax",
      path: entra.callbackPath,
    });
  }).pipe(
    Effect.catchTag("CookiesError", () =>
      Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
    ),
  );

/**
 * Registered on the configured callback path. The router tries static routes
 * before the `*` static and SPA fallback, so the callback is answered by the
 * server even outside `/api`.
 */
const entraSignInCallbackRoute = Layer.unwrap(
  Effect.gen(function* () {
    const entra = yield* EntraSignIn.EntraSignIn;
    return HttpRouter.add("GET", entra.callbackPath, handleEntraSignInCallback(entra));
  }),
);

export const entraSignInRouteLayer = Layer.mergeAll(
  entraSignInStartRoute,
  entraSignInCallbackRoute,
);
