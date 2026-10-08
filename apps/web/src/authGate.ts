import type { ServerAuthGateState } from "./environments/primary";

export type AuthGateState =
  | ServerAuthGateState
  | { readonly status: "hosted-pairing" }
  | { readonly status: "hosted-static" };

/**
 * Whether a route behind the app shell must send this browser to /pair.
 * Portal sign-in states are rendered by the root on the requested URL
 * instead, so a deep link survives sign-in.
 */
export function requiresPairingRedirect(state: AuthGateState): boolean {
  return state.status === "requires-auth" || state.status === "hosted-pairing";
}

export function isPortalGateState(
  state: AuthGateState,
): state is Extract<AuthGateState, { status: "portal-sign-in" | "portal-no-access" }> {
  return state.status === "portal-sign-in" || state.status === "portal-no-access";
}

/**
 * Whether a freshly read portal state no longer matches the gate the root
 * rendered. Null means the session is not a portal user, which leaves the
 * existing gate alone.
 */
export function portalGateChanged(
  current: AuthGateState,
  next: ServerAuthGateState | null,
): boolean {
  if (next === null || next.status !== current.status) return next !== null;
  return (
    next.status === "portal-no-access" &&
    current.status === "portal-no-access" &&
    next.access !== current.access
  );
}
