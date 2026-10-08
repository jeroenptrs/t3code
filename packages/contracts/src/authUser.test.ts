import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AuthUserIdentity, AuthUserRoleScopes, authUserEffectiveScopes } from "./authUser.ts";

const decodeIdentity = Schema.decodeUnknownSync(AuthUserIdentity);

describe("authUserEffectiveScopes", () => {
  it("grants role scopes only to active users", () => {
    expect(authUserEffectiveScopes({ status: "active", role: "reader" })).toEqual([
      "orchestration:read",
    ]);
    expect(authUserEffectiveScopes({ status: "pending", role: null })).toEqual([]);
    expect(authUserEffectiveScopes({ status: "disabled", role: "administrator" })).toEqual([]);
  });

  it("keeps reader read-only and reserves access management for administrators", () => {
    expect(AuthUserRoleScopes.reader.every((scope) => scope.endsWith(":read"))).toBe(true);
    expect(AuthUserRoleScopes.operator).toContain("orchestration:operate");
    expect(AuthUserRoleScopes.operator).not.toContain("access:write");
    expect(AuthUserRoleScopes.administrator).toContain("access:write");
  });
});

describe("AuthUserIdentity", () => {
  it("normalizes GUID case so portal and token IDs name the same user", () => {
    expect(
      decodeIdentity({
        tenantId: " 8F2C3A1E-1B2C-4D5E-8F90-123456789ABC ",
        objectId: "00000000-0000-4000-8000-00000000000A",
      }),
    ).toEqual({
      tenantId: "8f2c3a1e-1b2c-4d5e-8f90-123456789abc",
      objectId: "00000000-0000-4000-8000-00000000000a",
    });
    expect(() => decodeIdentity({ tenantId: "contoso", objectId: "x" })).toThrow();
  });
});
