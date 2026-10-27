import type { ExpoConfig } from "expo/config";

import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

const repoEnv = loadRepoEnv();

// A private device build signs with your own team and bundle id, from the repository-root
// .env.local or the shell. The TV id is T3CODE_TV_BUNDLE_ID, else the phone id plus ".tv".
const appleTeamId = repoEnv.T3CODE_IOS_APPLE_TEAM_ID?.trim() || undefined;
const phoneBundleIdentifier = repoEnv.T3CODE_IOS_BUNDLE_ID?.trim();
const bundleIdentifier =
  repoEnv.T3CODE_TV_BUNDLE_ID?.trim() ||
  (phoneBundleIdentifier ? `${phoneBundleIdentifier}.tv` : "com.t3tools.t3code.tv");

const config: ExpoConfig = {
  name: "T3 Code TV",
  slug: "t3-code-tv",
  version: "0.0.0",
  ios: {
    bundleIdentifier,
    ...(appleTeamId ? { appleTeamId } : {}),
  },
  plugins: [["@react-native-tvos/config-tv", { isTV: true }]],
  // Same shape as apps/mobile/app.config.ts, read by src/features/cloud/publicConfig.ts.
  extra: {
    relay: {
      url: repoEnv.T3CODE_RELAY_URL ?? null,
    },
    clerk: {
      publishableKey: repoEnv.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null,
      jwtTemplate: repoEnv.EXPO_PUBLIC_CLERK_JWT_TEMPLATE ?? null,
    },
  },
};

export default config;
