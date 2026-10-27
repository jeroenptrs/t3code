import { ClerkProvider } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import type { ReactNode } from "react";

import { hasCloudPublicConfig, resolveCloudPublicConfig } from "./publicConfig";

const cloudConfig = resolveCloudPublicConfig();
// Build-time constant: null when this build has no cloud config.
const publishableKey = hasCloudPublicConfig(cloudConfig) ? cloudConfig.clerk.publishableKey : null;

export const isCloudAuthConfigured = publishableKey !== null;

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
