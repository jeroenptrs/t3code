const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { resolve: metroResolve } = require("metro-resolver");

/** @type {import("expo/metro-config").MetroConfig} */
const config = getDefaultConfig(__dirname);
const workspaceRoot = path.resolve(__dirname, "../..");
const escapedWorkspaceRoot = workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// pnpm stores the fork as node_modules/.pnpm/react-native-tvos@.../node_modules/react-native-tvos.
// Imports of `react-native` from inside the fork, from packages without a `react-native`
// sibling, or through Expo's workspace autolinking resolver (which resolves from inside the
// fork's directory) fall through to node_modules/.pnpm/node_modules/react-native: the upstream
// package apps/mobile uses. Resolve every `react-native` import from this app instead, so it
// goes through apps/tv/node_modules/react-native and keeps the fork's `exports` map.
const reactNativeOrigin = path.join(__dirname, "index.ts");

config.watchFolders = [...new Set([...(config.watchFolders ?? []), workspaceRoot])];
config.resolver = {
  ...config.resolver,
  blockList: [
    ...(Array.isArray(config.resolver?.blockList)
      ? config.resolver.blockList
      : config.resolver?.blockList
        ? [config.resolver.blockList]
        : []),
    new RegExp(`${escapedWorkspaceRoot}[/\\\\]\\.t3[/\\\\].*`),
  ],
  resolveRequest: (context, moduleName, platform) => {
    if (moduleName === "react-native" || moduleName.startsWith("react-native/")) {
      // Call Metro's resolver directly, without context.resolveRequest: that is Expo's chain,
      // whose workspace autolinking step would redirect back to the upstream package.
      return metroResolve(
        {
          ...context,
          originModulePath: reactNativeOrigin,
          nodeModulesPaths: [],
          resolveRequest: undefined,
        },
        moduleName,
        platform,
      );
    }
    return context.resolveRequest(context, moduleName, platform);
  },
};

module.exports = config;
