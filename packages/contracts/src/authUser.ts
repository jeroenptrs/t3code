import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  AuthAdministrativeScopes,
  AuthEnvironmentScopes,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  ServerAuthDescriptor,
  ServerAuthSessionMethod,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

/**
 * Entra tenant and object IDs are GUIDs. Decoding lowercases them so an ID
 * pasted from the Azure portal and one read from a token claim name the same
 * user. Decode at the boundary (CLI flag, verified token claims) before
 * handing an identity to the user registry.
 */
export const EntraGuid = TrimmedString.pipe(
  Schema.decode(SchemaTransformation.toLowerCase()),
).check(Schema.isGUID());
export type EntraGuid = typeof EntraGuid.Type;

/**
 * The only key that identifies a human portal user. Email and display name are
 * labels from the latest sign-in and never take part in authorization.
 */
export const AuthUserIdentity = Schema.Struct({
  tenantId: EntraGuid,
  objectId: EntraGuid,
});
export type AuthUserIdentity = typeof AuthUserIdentity.Type;

export const AuthUserId = TrimmedNonEmptyString.pipe(Schema.brand("AuthUserId"));
export type AuthUserId = typeof AuthUserId.Type;

/**
 * - `pending`: signed in once, waits for an administrator; no access
 * - `active`: has the access of its role
 * - `disabled`: no access; keeps its role so re-enabling restores it
 */
export const AuthUserStatus = Schema.Literals(["pending", "active", "disabled"]);
export type AuthUserStatus = typeof AuthUserStatus.Type;

export const AuthUserRole = Schema.Literals(["reader", "operator", "administrator"]);
export type AuthUserRole = typeof AuthUserRole.Type;

export const AuthUser = Schema.Struct({
  userId: AuthUserId,
  identity: AuthUserIdentity,
  status: AuthUserStatus,
  /** Null until an administrator approves the user. */
  role: Schema.NullOr(AuthUserRole),
  email: Schema.NullOr(TrimmedNonEmptyString),
  displayName: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  lastSignInAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type AuthUser = typeof AuthUser.Type;

/** Who changed a user's access: another portal user, or the host-local CLI. */
export const AuthUserAccessActor = Schema.Union([
  Schema.Struct({ type: Schema.Literal("user"), userId: AuthUserId }),
  Schema.Struct({ type: Schema.Literal("host-cli") }),
]);
export type AuthUserAccessActor = typeof AuthUserAccessActor.Type;

/** One audited change to a user's status or role. `previous*` is null when the change created the user. */
export const AuthUserAccessChange = Schema.Struct({
  sequence: NonNegativeInt,
  userId: AuthUserId,
  actor: AuthUserAccessActor,
  previousStatus: Schema.NullOr(AuthUserStatus),
  status: AuthUserStatus,
  previousRole: Schema.NullOr(AuthUserRole),
  role: Schema.NullOr(AuthUserRole),
  changedAt: Schema.DateTimeUtc,
});
export type AuthUserAccessChange = typeof AuthUserAccessChange.Type;

/**
 * Reader sees portal data and nothing else. Operator gets what an ordinary
 * paired client gets, which already includes agent execution, terminals and
 * filesystem access. Administrator adds access and relay management.
 */
export const AuthUserRoleScopes = {
  reader: [AuthOrchestrationReadScope],
  operator: AuthStandardClientScopes,
  administrator: AuthAdministrativeScopes,
} as const satisfies Record<AuthUserRole, ReadonlyArray<AuthEnvironmentScope>>;

/** Scopes a user's sessions may hold right now. Pending and disabled users get none. */
export const authUserEffectiveScopes = (
  user: Pick<AuthUser, "status" | "role">,
): ReadonlyArray<AuthEnvironmentScope> =>
  user.status === "active" && user.role !== null ? AuthUserRoleScopes[user.role] : [];

/** What a user-bound session learns about its own user. */
export const AuthSessionUser = Schema.Struct({
  userId: AuthUserId,
  status: AuthUserStatus,
  role: Schema.NullOr(AuthUserRole),
  email: Schema.NullOr(TrimmedNonEmptyString),
  displayName: Schema.NullOr(TrimmedNonEmptyString),
});
export type AuthSessionUser = typeof AuthSessionUser.Type;

/**
 * What `/api/auth/session` tells a client about its credential. Sessions from
 * Entra sign-in carry `user`; a pending or disabled user is authenticated with
 * no scopes, so the client can say why it shows nothing.
 */
export const AuthSessionState = Schema.Struct({
  authenticated: Schema.Boolean,
  auth: ServerAuthDescriptor,
  scopes: Schema.optionalKey(AuthEnvironmentScopes),
  sessionMethod: Schema.optionalKey(ServerAuthSessionMethod),
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
  user: Schema.optionalKey(AuthSessionUser),
});
export type AuthSessionState = typeof AuthSessionState.Type;

/**
 * Browser navigation target for Entra sign-in. It is a redirect, not an API
 * call, and accepts `?returnTo=<same-origin path>`. The callback path is
 * server configuration; a failed callback redirects to
 * `/?signInError=<EntraSignInFailureReason>`.
 */
export const ENTRA_SIGN_IN_START_PATH = "/api/auth/entra/start";
export const ENTRA_SIGN_IN_RETURN_TO_PARAM = "returnTo";
export const ENTRA_SIGN_IN_ERROR_PARAM = "signInError";

/**
 * - `provider_error`: Entra refused or the user cancelled
 * - `invalid_state`: the sign-in started elsewhere, expired, or was tampered with
 * - `token_exchange_failed`: Entra did not redeem the authorization code
 * - `invalid_id_token`: the identity token failed verification
 * - `internal_error`: T3 could not record the sign-in
 */
export const EntraSignInFailureReason = Schema.Literals([
  "provider_error",
  "invalid_state",
  "token_exchange_failed",
  "invalid_id_token",
  "internal_error",
]);
export type EntraSignInFailureReason = typeof EntraSignInFailureReason.Type;

export const AuthUserApproveInput = Schema.Struct({
  userId: AuthUserId,
  role: AuthUserRole,
});
export type AuthUserApproveInput = typeof AuthUserApproveInput.Type;

export const AuthUserChangeRoleInput = Schema.Struct({
  userId: AuthUserId,
  role: AuthUserRole,
});
export type AuthUserChangeRoleInput = typeof AuthUserChangeRoleInput.Type;

/** `role` is required when the user was disabled before approval. */
export const AuthUserEnableInput = Schema.Struct({
  userId: AuthUserId,
  role: Schema.optionalKey(AuthUserRole),
});
export type AuthUserEnableInput = typeof AuthUserEnableInput.Type;

/** Names the user for disable and session revocation. */
export const AuthUserTargetInput = Schema.Struct({
  userId: AuthUserId,
});
export type AuthUserTargetInput = typeof AuthUserTargetInput.Type;

export const AuthUserAccessChangesQuery = Schema.Struct({
  userId: Schema.optionalKey(AuthUserId),
});
export type AuthUserAccessChangesQuery = typeof AuthUserAccessChangesQuery.Type;

export const AuthUserSessionsRevokeResult = Schema.Struct({
  revokedCount: NonNegativeInt,
});
export type AuthUserSessionsRevokeResult = typeof AuthUserSessionsRevokeResult.Type;

export const AuthSignOutResult = Schema.Struct({
  signedOut: Schema.Boolean,
});
export type AuthSignOutResult = typeof AuthSignOutResult.Type;
