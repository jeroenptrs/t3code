import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  AuthAdministrativeScopes,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
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
