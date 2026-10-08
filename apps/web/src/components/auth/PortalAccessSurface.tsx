import type { AuthSessionUser, EntraSignInFailureReason } from "@t3tools/contracts";
import {
  buildEntraSignInUrl,
  describeEntraSignInFailure,
  portalReturnPath,
  portalUserLabel,
} from "@t3tools/client-runtime/portal-user";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import { resetServerAuthGate, signOutPrimarySession } from "../../environments/primary";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

/** Starts Entra sign-in, coming back to the page the browser is on. */
export function startPortalSignIn(): void {
  window.location.assign(buildEntraSignInUrl(portalReturnPath(new URL(window.location.href))));
}

/**
 * Ends the T3 session and reloads at the root, so nothing from this user's
 * session stays in memory for whoever signs in next.
 */
export function usePortalSignOut() {
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const signOut = useCallback(async () => {
    setIsSigningOut(true);
    setSignOutError(null);
    try {
      await signOutPrimarySession();
      window.location.replace("/");
    } catch {
      setSignOutError("Could not sign out. Try again.");
      setIsSigningOut(false);
    }
  }, []);
  return { signOut, isSigningOut, signOutError };
}

export function PortalSignInSurface({
  signInFailure,
}: {
  readonly signInFailure?: EntraSignInFailureReason;
}) {
  return (
    <StandalonePage tone="brand">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title="Sign in to continue"
        description="Use your Microsoft work account. An administrator decides what you can access."
      />
      {signInFailure ? (
        <Alert variant="error" className="mt-6">
          <AlertDescription>{describeEntraSignInFailure(signInFailure)}</AlertDescription>
        </Alert>
      ) : null}
      <div className="mt-6 flex flex-wrap gap-2">
        <Button size="sm" onClick={startPortalSignIn}>
          Sign in with Microsoft
        </Button>
      </div>
    </StandalonePage>
  );
}

export function PortalNoAccessSurface({
  access,
  user,
}: {
  readonly access: "awaiting-approval" | "disabled";
  readonly user: AuthSessionUser;
}) {
  const router = useRouter();
  const [isChecking, setIsChecking] = useState(false);
  const { signOut, isSigningOut, signOutError } = usePortalSignOut();
  const label = portalUserLabel(user);
  const identity = user.email && user.email !== label ? `${label} (${user.email})` : label;

  const checkAgain = async () => {
    setIsChecking(true);
    resetServerAuthGate();
    await router.invalidate().finally(() => setIsChecking(false));
  };

  return (
    <StandalonePage tone={access === "disabled" ? "error" : "brand"}>
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title={access === "disabled" ? "Your access is disabled" : "Waiting for approval"}
        description={
          access === "disabled"
            ? "An administrator has disabled your access. Contact them if you think this is a mistake."
            : "An administrator needs to approve your account and choose what you can do. Check again once they have."
        }
      />
      <p className="mt-6 text-sm text-muted-foreground">
        Signed in as <span className="font-medium text-foreground">{identity}</span>
      </p>
      {signOutError ? (
        <Alert variant="error" className="mt-4">
          <AlertDescription>{signOutError}</AlertDescription>
        </Alert>
      ) : null}
      <div className="mt-6 flex flex-wrap gap-2">
        <Button size="sm" disabled={isChecking || isSigningOut} onClick={() => void checkAgain()}>
          {isChecking ? "Checking…" : "Check again"}
        </Button>
        <Button size="sm" variant="outline" disabled={isSigningOut} onClick={() => void signOut()}>
          {isSigningOut ? "Signing out…" : "Sign out"}
        </Button>
      </div>
    </StandalonePage>
  );
}
