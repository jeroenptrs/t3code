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

const iconLayers = (size: string) => ({
  front: `./assets/icon-front-${size}.png`,
  middle: `./assets/icon-middle-${size}.png`,
  back: `./assets/icon-back-${size}.png`,
});

const config: ExpoConfig = {
  name: "T3 Code TV",
  slug: "t3-code-tv",
  version: "0.0.0",
  ios: {
    bundleIdentifier,
    ...(appleTeamId ? { appleTeamId } : {}),
  },
  plugins: [
    [
      "@react-native-tvos/config-tv",
      {
        isTV: true,
        // Generated from the nightly icon by `vp run icons:generate`; layers give the parallax.
        appleTVImages: {
          iconLayers: iconLayers("1280x768"),
          iconSmallLayers: iconLayers("400x240"),
          iconSmall2xLayers: iconLayers("800x480"),
          topShelf: "./assets/top-shelf-1920x720.png",
          topShelf2x: "./assets/top-shelf-3840x1440.png",
          topShelfWide: "./assets/top-shelf-2320x720.png",
          topShelfWide2x: "./assets/top-shelf-4640x1440.png",
        },
      },
    ],
  ],
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
