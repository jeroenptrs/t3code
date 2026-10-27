import type { ExpoConfig } from "expo/config";

import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

const repoEnv = loadRepoEnv();

const config: ExpoConfig = {
  name: "T3 Code TV",
  slug: "t3-code-tv",
  version: "0.0.0",
  ios: {
    bundleIdentifier: "com.t3tools.t3code.tv",
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
