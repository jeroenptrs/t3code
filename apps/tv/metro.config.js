const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { resolve: metroResolve } = require("metro-resolver");

/** @type {import("expo/metro-config").MetroConfig} */
const config = getDefaultConfig(__dirname);
const workspaceRoot = path.resolve(__dirname, "../..");
const escapedWorkspaceRoot = workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Resolve every `react-native` import from this app, not from the importer. Expo's workspace
// autolinking resolver and packages without a `react-native` sibling otherwise fall through to
// node_modules/.pnpm/node_modules/react-native, the upstream copy apps/mobile uses, instead of
// the tvOS fork behind apps/tv/node_modules/react-native and its `exports` map.
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
