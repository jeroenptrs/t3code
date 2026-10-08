import {
  AuthUserId,
  EnvironmentOperationForbiddenError,
  EnvironmentUserAccessConflictError,
  type AuthSessionState,
  type AuthSessionUser,
  type AuthUser,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  buildEntraSignInUrl,
  canManagePortalUsers,
  canReadPortalUsers,
  describeUserAccessChange,
  describeThreadCreator,
  describeUserAdminError,
  describeWebhookAudit,
  portalReturnPath,
  portalUserActions,
  readEntraSignInFailure,
  resolvePortalAccess,
  sortPortalUsers,
  stripEntraSignInFailure,
} from "./portalUser.ts";

const AUTH: AuthSessionState["auth"] = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "t3_session",
  entraSignIn: true,
};

const user = (status: AuthSessionUser["status"]): AuthSessionUser => ({
  userId: AuthUserId.make("user-1"),
  status,
  role: status === "pending" ? null : "operator",
  email: "ada@example.com",
  displayName: "Ada",
});

describe("resolvePortalAccess", () => {
  it("is signed out when Entra is on and there is no session", () => {
    expect(resolvePortalAccess({ authenticated: false, auth: AUTH })).toEqual({
      kind: "signed-out",
    });
  });

  it("leaves pairing alone when Entra is off", () => {
    const auth = { ...AUTH, entraSignIn: false };
    expect(resolvePortalAccess({ authenticated: false, auth }).kind).toBe("not-portal");
    expect(
      resolvePortalAccess({ authenticated: true, auth, scopes: ["orchestration:read"] }).kind,
    ).toBe("not-portal");
  });

  it("treats an authenticated credential without a user as not a portal user", () => {
    expect(resolvePortalAccess({ authenticated: true, auth: AUTH, scopes: [] }).kind).toBe(
      "not-portal",
    );
  });

  it("follows the user's status", () => {
    const session = (status: AuthSessionUser["status"]): AuthSessionState => ({
      authenticated: true,
      auth: AUTH,
      scopes: [],
      user: user(status),
    });
    expect(resolvePortalAccess(session("pending")).kind).toBe("awaiting-approval");
    expect(resolvePortalAccess(session("disabled")).kind).toBe("disabled");
    expect(resolvePortalAccess(session("active")).kind).toBe("signed-in");
  });
});

describe("user administration access", () => {
  const session = (scopes: AuthSessionState["scopes"], withUser = true): AuthSessionState => ({
    authenticated: true,
    auth: AUTH,
    ...(scopes ? { scopes } : {}),
    ...(withUser ? { user: user("active") } : {}),
  });

  it("reads with access:read and manages only with access:write from a user session", () => {
    expect(canReadPortalUsers(session(["orchestration:read"]))).toBe(false);
    expect(canReadPortalUsers(session(["access:read"]))).toBe(true);
    expect(canManagePortalUsers(session(["access:read"]))).toBe(false);
    expect(canManagePortalUsers(session(["access:read", "access:write"]))).toBe(true);
    expect(canManagePortalUsers(session(["access:read", "access:write"], false))).toBe(false);
  });

  it("hides users when Entra is off", () => {
    expect(
      canReadPortalUsers({ ...session(["access:read"]), auth: { ...AUTH, entraSignIn: false } }),
    ).toBe(false);
  });
});

describe("sign-in navigation", () => {
  it("returns to the deep link without a stale sign-in error", () => {
    const url = new URL(
      "https://portal.example/env-1/thread-1?signInError=invalid_state&tab=diff#turn-3",
    );
    expect(portalReturnPath(url)).toBe("/env-1/thread-1?tab=diff#turn-3");
  });

  it("encodes the return path as one query parameter", () => {
    expect(buildEntraSignInUrl("/env-1/thread-1?tab=diff#turn-3")).toBe(
      "/api/auth/entra/start?returnTo=%2Fenv-1%2Fthread-1%3Ftab%3Ddiff%23turn-3",
    );
  });

  it("reads and strips the callback failure reason", () => {
    const url = new URL("https://portal.example/?signInError=token_exchange_failed&x=1");
    expect(readEntraSignInFailure(url)).toBe("token_exchange_failed");
    expect(stripEntraSignInFailure(url)?.href).toBe("https://portal.example/?x=1");
    expect(stripEntraSignInFailure(new URL("https://portal.example/"))).toBeNull();
    expect(readEntraSignInFailure(new URL("https://portal.example/"))).toBeNull();
  });

  it("reads an unknown failure reason as an internal error", () => {
    expect(readEntraSignInFailure(new URL("https://portal.example/?signInError=nope"))).toBe(
      "internal_error",
    );
  });
});

describe("user list", () => {
  const now = DateTime.makeUnsafe("2026-10-01T00:00:00Z");
  const authUser = (
    userId: string,
    status: AuthUser["status"],
    displayName: string | null,
  ): AuthUser => ({
    userId: AuthUserId.make(userId),
    identity: {
      tenantId: "00000000-0000-0000-0000-000000000001",
      objectId: "00000000-0000-0000-0000-000000000002",
    },
    status,
    role: status === "pending" ? null : "reader",
    email: `${userId}@example.com`,
    displayName,
    createdAt: now,
    updatedAt: now,
    lastSignInAt: null,
  });

  it("puts pending users first, then sorts by label", () => {
    const sorted = sortPortalUsers([
      authUser("u1", "disabled", "Cy"),
      authUser("u2", "active", "Bo"),
      authUser("u3", "pending", "Zed"),
      authUser("u4", "active", "Al"),
    ]);
    expect(sorted.map((entry) => entry.displayName)).toEqual(["Zed", "Al", "Bo", "Cy"]);
  });

  it("offers only transitions the registry accepts", () => {
    expect(portalUserActions({ status: "pending", role: null })).toEqual([
      "approve",
      "disable",
      "revoke-sessions",
    ]);
    expect(portalUserActions({ status: "active", role: "reader" })).toEqual([
      "change-role",
      "disable",
      "revoke-sessions",
    ]);
    expect(portalUserActions({ status: "disabled", role: "reader" })).toEqual([
      "enable",
      "revoke-sessions",
    ]);
    expect(portalUserActions({ status: "disabled", role: null })).toEqual([
      "enable-with-role",
      "revoke-sessions",
    ]);
  });
});

describe("describeUserAccessChange", () => {
  it("describes each kind of audited change", () => {
    expect(
      describeUserAccessChange({
        previousStatus: null,
        status: "pending",
        previousRole: null,
        role: null,
      }),
    ).toBe("First sign-in");
    expect(
      describeUserAccessChange({
        previousStatus: null,
        status: "active",
        previousRole: null,
        role: "administrator",
      }),
    ).toBe("Provisioned as Administrator");
    expect(
      describeUserAccessChange({
        previousStatus: "pending",
        status: "active",
        previousRole: null,
        role: "operator",
      }),
    ).toBe("Approved as Operator");
    expect(
      describeUserAccessChange({
        previousStatus: "active",
        status: "active",
        previousRole: "operator",
        role: "reader",
      }),
    ).toBe("Role changed from Operator to Reader");
    expect(
      describeUserAccessChange({
        previousStatus: "active",
        status: "disabled",
        previousRole: "reader",
        role: "reader",
      }),
    ).toBe("Disabled");
    expect(
      describeUserAccessChange({
        previousStatus: "disabled",
        status: "active",
        previousRole: "reader",
        role: "reader",
      }),
    ).toBe("Enabled");
  });
});

describe("describeUserAdminError", () => {
  it("explains registry refusals and missing user sessions", () => {
    expect(
      describeUserAdminError(
        new EnvironmentUserAccessConflictError({
          code: "user_access_conflict",
          reason: "last_administrator",
          userId: AuthUserId.make("user-1"),
          traceId: "trace",
        }),
      ),
    ).toMatch(/last active administrator/);
    expect(
      describeUserAdminError(
        new EnvironmentOperationForbiddenError({
          code: "operation_forbidden",
          reason: "user_session_required",
          traceId: "trace",
        }),
      ),
    ).toMatch(/Microsoft account/);
  });
});

describe("describeWebhookAudit", () => {
  const formatDate = (isoDate: string) => isoDate.slice(0, 10);
  const endpoint = { path: "/api/hooks/task/token", url: null, hasSecret: false };

  it("says nothing for a hook with no recorded users or rotation", () => {
    expect(describeWebhookAudit(endpoint, formatDate)).toEqual([]);
  });

  it("names the creator and rotator, and falls back for a removed user", () => {
    expect(
      describeWebhookAudit(
        {
          ...endpoint,
          createdByUser: { userId: AuthUserId.make("user-1"), name: "Ada" },
          tokenRotatedAt: "2026-10-04T09:00:00.000Z",
          tokenRotatedByUser: { userId: AuthUserId.make("user-2"), name: null },
        },
        formatDate,
      ),
    ).toEqual(["Created by Ada", "Token last rotated by a removed user on 2026-10-04"]);
  });

  it("dates a rotation even when no user made it", () => {
    expect(
      describeWebhookAudit({ ...endpoint, tokenRotatedAt: "2026-10-04T09:00:00.000Z" }, formatDate),
    ).toEqual(["Token last rotated on 2026-10-04"]);
  });
});

describe("describeThreadCreator", () => {
  it("names the user who started a thread, and falls back for a removed user", () => {
    expect(describeThreadCreator(undefined)).toBeNull();
    expect(describeThreadCreator({ userId: AuthUserId.make("user-1"), name: "Ada" })).toBe(
      "Started by Ada",
    );
    expect(describeThreadCreator({ userId: AuthUserId.make("user-2"), name: null })).toBe(
      "Started by a removed user",
    );
  });
});
