import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  sessionGrantsScope,
  ENTRA_SIGN_IN_ERROR_PARAM,
  ENTRA_SIGN_IN_RETURN_TO_PARAM,
  ENTRA_SIGN_IN_START_PATH,
  EntraSignInFailureReason,
  EnvironmentAuthInvalidError,
  EnvironmentOperationForbiddenError,
  EnvironmentResourceNotFoundError,
  EnvironmentScopeRequiredError,
  EnvironmentUserAccessConflictError,
  type AuthSessionState,
  type AuthSessionUser,
  type AuthUser,
  type AuthUserAccessActor,
  type AuthUserAccessChange,
  type AuthUserReference,
  type AuthUserRole,
  type AuthUserStatus,
  type EnvironmentUserAccessConflictReason,
  type ScheduledTaskWebhookEndpoint,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Where a browser stands with Entra sign-in, read from `/api/auth/session`.
 * `not-portal` means Entra sign-in is off or the credential is not a portal
 * user, so the existing pairing flow applies unchanged.
 */
export type PortalAccess =
  | { readonly kind: "not-portal" }
  | { readonly kind: "signed-out" }
  | { readonly kind: "awaiting-approval"; readonly user: AuthSessionUser }
  | { readonly kind: "disabled"; readonly user: AuthSessionUser }
  | { readonly kind: "signed-in"; readonly user: AuthSessionUser };

export function resolvePortalAccess(session: AuthSessionState): PortalAccess {
  if (session.authenticated && session.user) {
    switch (session.user.status) {
      case "pending":
        return { kind: "awaiting-approval", user: session.user };
      case "disabled":
        return { kind: "disabled", user: session.user };
      case "active":
        return { kind: "signed-in", user: session.user };
    }
  }
  if (!session.authenticated && session.auth.entraSignIn === true) {
    return { kind: "signed-out" };
  }
  return { kind: "not-portal" };
}

/** The Users settings page needs Entra sign-in on and `access:read`. */
export function canReadPortalUsers(session: AuthSessionState | null): boolean {
  return (
    session?.authenticated === true &&
    session.auth.entraSignIn === true &&
    sessionGrantsScope(session, AuthAccessReadScope)
  );
}

/** Changing access needs `access:write` from a session signed in as a user, so the audit log names who did it. */
export function canManagePortalUsers(session: AuthSessionState | null): boolean {
  return (
    canReadPortalUsers(session) &&
    session?.user !== undefined &&
    sessionGrantsScope(session, AuthAccessWriteScope)
  );
}

/** Display name, then email, then the opaque ID. Labels never authorize anything. */
export function portalUserLabel(
  user: Pick<AuthSessionUser, "userId" | "displayName" | "email">,
): string {
  return user.displayName ?? user.email ?? user.userId;
}

export const PORTAL_USER_ROLES: ReadonlyArray<AuthUserRole> = [
  "reader",
  "operator",
  "administrator",
];

export const PORTAL_USER_ROLE_LABELS: Readonly<Record<AuthUserRole, string>> = {
  reader: "Reader",
  operator: "Operator",
  administrator: "Administrator",
};

export const PORTAL_USER_ROLE_DESCRIPTIONS: Readonly<Record<AuthUserRole, string>> = {
  reader: "Can read projects and threads.",
  operator: "Can run agents, terminals, and edit files.",
  administrator: "Operator access, plus managing users and connections.",
};

export const PORTAL_USER_STATUS_LABELS: Readonly<Record<AuthUserStatus, string>> = {
  pending: "Awaiting approval",
  active: "Active",
  disabled: "Disabled",
};

/**
 * Same-origin path the sign-in should come back to: the current page without
 * a stale sign-in error. The server only honors relative paths.
 */
export function portalReturnPath(url: URL): string {
  const next = new URL(url.href);
  next.searchParams.delete(ENTRA_SIGN_IN_ERROR_PARAM);
  return `${next.pathname}${next.search}${next.hash}`;
}

/** A full browser navigation target, not an API call. */
export function buildEntraSignInUrl(returnTo: string): string {
  return `${ENTRA_SIGN_IN_START_PATH}?${new URLSearchParams({
    [ENTRA_SIGN_IN_RETURN_TO_PARAM]: returnTo,
  }).toString()}`;
}

const isEntraSignInFailureReason = Schema.is(EntraSignInFailureReason);

/** The failed callback's reason. An unrecognized value reads as an internal error. */
export function readEntraSignInFailure(url: URL): EntraSignInFailureReason | null {
  const value = url.searchParams.get(ENTRA_SIGN_IN_ERROR_PARAM);
  if (value === null) return null;
  return isEntraSignInFailureReason(value) ? value : "internal_error";
}

/** The URL without the sign-in error parameter, or null when it has none. */
export function stripEntraSignInFailure(url: URL): URL | null {
  if (!url.searchParams.has(ENTRA_SIGN_IN_ERROR_PARAM)) return null;
  const next = new URL(url.href);
  next.searchParams.delete(ENTRA_SIGN_IN_ERROR_PARAM);
  return next;
}

export function describeEntraSignInFailure(reason: EntraSignInFailureReason): string {
  switch (reason) {
    case "provider_error":
      return "Microsoft sign-in was cancelled or refused. Try again, or ask an administrator if it keeps happening.";
    case "invalid_state":
      return "That sign-in attempt expired or was started in another tab. Sign in again.";
    case "token_exchange_failed":
      return "Microsoft did not complete the sign-in. Try again in a moment.";
    case "invalid_id_token":
      return "Your Microsoft identity could not be verified. Ask an administrator to check the sign-in configuration.";
    case "internal_error":
      return "T3 Code could not record your sign-in. Try again, or ask an administrator to check the server logs.";
  }
}

export function describeUserAccessConflict(reason: EnvironmentUserAccessConflictReason): string {
  switch (reason) {
    case "invalid_transition":
      return "This user's status has changed. Refresh the list and try again.";
    case "role_required":
      return "Choose a role to enable a user who was never approved.";
    case "last_administrator":
      return "This is the last active administrator. Make someone else an administrator first.";
  }
}

const isConflictError = Schema.is(EnvironmentUserAccessConflictError);
const isNotFoundError = Schema.is(EnvironmentResourceNotFoundError);
const isForbiddenError = Schema.is(EnvironmentOperationForbiddenError);
const isScopeRequiredError = Schema.is(EnvironmentScopeRequiredError);
const isAuthInvalidError = Schema.is(EnvironmentAuthInvalidError);

/** A message for a failed user list read or access change, shown where it was attempted. */
export function describeUserAdminError(error: unknown): string {
  if (isConflictError(error)) return describeUserAccessConflict(error.reason);
  if (isNotFoundError(error) && error.reason === "user_not_found") {
    return "This user no longer exists. Refresh the list.";
  }
  if (isForbiddenError(error) && error.reason === "user_session_required") {
    return "Changing user access requires signing in with your Microsoft account.";
  }
  if (isScopeRequiredError(error)) return "Your role does not allow this.";
  if (isAuthInvalidError(error)) return "Your session has ended. Sign in again.";
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The request failed.";
}

const STATUS_ORDER: Readonly<Record<AuthUserStatus, number>> = {
  pending: 0,
  active: 1,
  disabled: 2,
};

/** Pending users lead so approvals are easy to find; then by label. */
export function sortPortalUsers(users: ReadonlyArray<AuthUser>): ReadonlyArray<AuthUser> {
  return [...users].sort(
    (left, right) =>
      STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
      portalUserLabel(left).localeCompare(portalUserLabel(right)),
  );
}

/**
 * Access changes the registry accepts for a user in this state. `approve`
 * and `enable-with-role` both ask for a role: enabling a user who was
 * disabled before approval needs one.
 */
export type PortalUserAction =
  | "approve"
  | "change-role"
  | "disable"
  | "enable"
  | "enable-with-role"
  | "revoke-sessions";

export function portalUserActions(
  user: Pick<AuthUser, "status" | "role">,
): ReadonlyArray<PortalUserAction> {
  switch (user.status) {
    case "pending":
      return ["approve", "disable", "revoke-sessions"];
    case "active":
      return ["change-role", "disable", "revoke-sessions"];
    case "disabled":
      return [user.role === null ? "enable-with-role" : "enable", "revoke-sessions"];
  }
}

export function describeUserAccessActor(
  actor: AuthUserAccessActor,
  labelForUser: (userId: AuthUser["userId"]) => string | null,
): string {
  return actor.type === "host-cli" ? "Host CLI" : (labelForUser(actor.userId) ?? "Unknown user");
}

/** One audited change in plain words, e.g. "Approved as Operator". */
export function describeUserAccessChange(
  change: Pick<AuthUserAccessChange, "previousStatus" | "status" | "previousRole" | "role">,
): string {
  const role = change.role === null ? null : PORTAL_USER_ROLE_LABELS[change.role];
  if (change.previousStatus === null) {
    return change.status === "pending"
      ? "First sign-in"
      : `Provisioned as ${role ?? PORTAL_USER_STATUS_LABELS[change.status]}`;
  }
  if (change.previousStatus !== change.status) {
    switch (change.status) {
      case "active":
        return change.previousStatus === "pending" || change.previousRole === null
          ? `Approved as ${role}`
          : change.previousRole === change.role
            ? "Enabled"
            : `Enabled as ${role}`;
      case "disabled":
        return "Disabled";
      case "pending":
        return "Returned to pending";
    }
  }
  if (change.previousRole !== change.role) {
    const previous =
      change.previousRole === null ? "no role" : PORTAL_USER_ROLE_LABELS[change.previousRole];
    return `Role changed from ${previous} to ${role ?? "no role"}`;
  }
  return "Access updated";
}

function userReferenceLabel(user: AuthUserReference): string {
  return user.name ?? "a removed user";
}

/**
 * Who created a webhook task and last rotated its token, one line each, for
 * whatever the server knows. `formatDate` renders the rotation's ISO time.
 */
export function describeWebhookAudit(
  endpoint: ScheduledTaskWebhookEndpoint,
  formatDate: (isoDate: string) => string,
): ReadonlyArray<string> {
  const lines: string[] = [];
  if (endpoint.createdByUser !== undefined) {
    lines.push(`Created by ${userReferenceLabel(endpoint.createdByUser)}`);
  }
  if (endpoint.tokenRotatedAt !== undefined) {
    const by =
      endpoint.tokenRotatedByUser === undefined
        ? ""
        : ` by ${userReferenceLabel(endpoint.tokenRotatedByUser)}`;
    lines.push(`Token last rotated${by} on ${formatDate(endpoint.tokenRotatedAt)}`);
  }
  return lines;
}

/** "Started by <name>" for a thread a portal user started; null when none did. */
export function describeThreadCreator(createdByUser: AuthUserReference | undefined): string | null {
  return createdByUser === undefined ? null : `Started by ${userReferenceLabel(createdByUser)}`;
}
