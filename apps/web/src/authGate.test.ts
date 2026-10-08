import { AuthUserId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { portalGateChanged } from "./authGate";

const user = {
  userId: AuthUserId.make("user-1"),
  status: "pending" as const,
  role: null,
  email: null,
  displayName: "Ada",
};

describe("portalGateChanged", () => {
  it("leaves the gate alone for sessions that are not portal users", () => {
    expect(portalGateChanged({ status: "authenticated" }, null)).toBe(false);
  });

  it("re-runs the gate when a signed-in user loses access", () => {
    const current = { status: "authenticated", portal: true } as const;
    expect(portalGateChanged(current, { status: "authenticated", portal: true })).toBe(false);
    expect(portalGateChanged(current, { status: "portal-sign-in" })).toBe(true);
    expect(
      portalGateChanged(current, { status: "portal-no-access", access: "disabled", user }),
    ).toBe(true);
  });

  it("re-runs the gate when a waiting user is disabled", () => {
    expect(
      portalGateChanged(
        { status: "portal-no-access", access: "awaiting-approval", user },
        { status: "portal-no-access", access: "disabled", user },
      ),
    ).toBe(true);
  });
});
