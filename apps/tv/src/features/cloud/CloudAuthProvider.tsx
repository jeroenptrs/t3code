import { ClerkProvider, getClerkInstance } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import type { ReactNode } from "react";

import { setTvCloudSession } from "../../connection/cloud-session";
import { cloudAccountService } from "./cloudAccountService";
import { hasCloudPublicConfig, resolveCloudPublicConfig } from "./publicConfig";

const cloudConfig = resolveCloudPublicConfig();
// Build-time constant: null when this build has no cloud config.
const publishableKey = hasCloudPublicConfig(cloudConfig) ? cloudConfig.clerk.publishableKey : null;

export const isCloudAuthConfigured = publishableKey !== null;

if (publishableKey) {
  // The singleton ClerkProvider renders with, as mobile does: the account service observes it
  // for the app's lifetime and installs or clears the relay session on sign-in and sign-out.
  // Passing the token cache here too keeps the keychain-backed client JWT from the first call.
  cloudAccountService.attach(
    getClerkInstance({ publishableKey, ...(tokenCache ? { tokenCache } : {}) }),
  );
} else {
  setTvCloudSession(null);
}

// @clerk/expo runs clerk-js headless here. Its optional native module
// (ClerkExpo, from @clerk/expo-native-components) is not in tvOS builds, and
// requireOptionalNativeModule returns null, so there is nothing to sync with.
// The session's client JWT persists in the keychain through expo-secure-store.
export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  if (!publishableKey) {
    return props.children;
  }

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      // undefined only on web; tvOS always gets the expo-secure-store cache.
      {...(tokenCache ? { tokenCache } : {})}
      __experimental_disableNativeClientSync
    >
      {props.children}
    </ClerkProvider>
  );
}
