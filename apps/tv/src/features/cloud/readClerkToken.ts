import { getClerkInstance, useAuth, useClerk, useUser } from "@clerk/expo";
import { relayClerkTokenOptions } from "@t3tools/shared/relayAuth";
import { useCallback } from "react";

import { resolveCloudPublicConfig } from "./publicConfig";

/**
 * Returns a session JWT for the given Clerk JWT template, or null when no one is
 * signed in or the build has no cloud config. Uses the same options as mobile
 * (relayClerkTokenOptions skips Clerk's cache, since the relay exchange wants a
 * fresh token).
 */
export async function readClerkToken(template: string): Promise<string | null> {
  const { publishableKey } = resolveCloudPublicConfig().clerk;
  if (!publishableKey) return null;
  const clerk = getClerkInstance({ publishableKey });
  if (!clerk.session) return null;
  return clerk.session.getToken(relayClerkTokenOptions(template));
}

/** readClerkToken with the build's configured template (`t3-relay` in production). */
export async function readRelayClerkToken(): Promise<string | null> {
  const { jwtTemplate } = resolveCloudPublicConfig().clerk;
  return jwtTemplate ? readClerkToken(jwtTemplate) : null;
}

export interface CloudAccount {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  readonly emailAddress: string | null;
  readonly signOut: () => Promise<void>;
}

/** Must render inside CloudAuthProvider with cloud config present. */
export function useCloudAccount(): CloudAccount {
  const { isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const clerk = useClerk();
  const signOut = useCallback(() => clerk.signOut(), [clerk]);
  return {
    isLoaded,
    isSignedIn: isSignedIn === true,
    userId: userId ?? null,
    emailAddress: user?.primaryEmailAddress?.emailAddress ?? null,
    signOut,
  };
}
