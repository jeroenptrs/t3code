import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "T3 Code TV",
  slug: "t3-code-tv",
  version: "0.0.0",
  ios: {
    bundleIdentifier: "com.t3tools.t3code.tv",
  },
  plugins: [["@react-native-tvos/config-tv", { isTV: true }]],
};

export default config;
