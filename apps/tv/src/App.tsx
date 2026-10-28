import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { BackHandler, Linking, StatusBar, StyleSheet, TVEventControl, View } from "react-native";

import { colors } from "./components/theme";
import { SignInScreen } from "./features/cloud/SignInScreen";
import { startDevLaunch } from "./lib/devLaunch";
import { parseTvLink } from "./lib/links";
import { ConnectionsScreen } from "./screens/ConnectionsScreen";
import { EnvironmentScreen } from "./screens/EnvironmentScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { tvAtomRegistry } from "./state/atom-registry";
import { environmentCatalog } from "./state/environments";
import { openPairingLink } from "./state/pairing-form";

export { setTvCloudSession, type TvCloudSessionInput } from "./connection/cloud-session";

type Screen =
  | { readonly name: "home" }
  | { readonly name: "connections" }
  | { readonly name: "signIn" }
  | { readonly name: "environment"; readonly environmentId: EnvironmentId };

/**
 * The TV app root. `cloudProvider` wraps everything inside the atom registry, so a Clerk
 * provider can call `setTvCloudSession` and render its sign-in entry in the connections screen.
 */
export function TvApp(props: {
  readonly cloudProvider?: ComponentType<{ readonly children: ReactNode }>;
}) {
  const CloudProvider = props.cloudProvider;
  const content = <Screens />;
  return (
    <RegistryContext.Provider value={tvAtomRegistry}>
      <StatusBar hidden />
      {CloudProvider ? <CloudProvider>{content}</CloudProvider> : content}
    </RegistryContext.Provider>
  );
}

// Menu goes back one level: thread (handled by its screen) -> environment -> home, and
// connections -> home. Home is the root once an environment is saved; before that, connections.
function parentOf(screen: Screen): Screen | null {
  switch (screen.name) {
    case "home":
      return null;
    case "signIn":
      return { name: "connections" };
    default:
      return { name: "home" };
  }
}

function Screens() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  // With nothing saved, Home has nothing to show, so connections stands in as the root.
  const shown: Screen =
    screen.name === "home" && catalog.isReady && catalog.entries.size === 0
      ? { name: "connections" }
      : screen;

  useEffect(() => {
    const open = (url: string | null | undefined) => {
      const link = url ? parseTvLink(url) : null;
      if (link === null) return;
      if (link.kind === "environment") {
        setScreen({ name: "environment", environmentId: link.environmentId });
        return;
      }
      setScreen({ name: "connections" });
      openPairingLink({ host: link.host, code: link.code });
    };
    void Linking.getInitialURL().then(open);
    const subscription = Linking.addEventListener("url", (event) => open(event.url));
    const stopDevLaunch = startDevLaunch({
      openEnvironment: (environmentId) => setScreen({ name: "environment", environmentId }),
      openHome: () => setScreen({ name: "home" }),
    });
    return () => {
      subscription.remove();
      stopDevLaunch();
    };
  }, []);

  // The remote's Menu button exits the app unless something handles it; on a nested screen it
  // goes back instead.
  useEffect(() => {
    const parent = parentOf(screen);
    if (parent === null) {
      TVEventControl.disableTVMenuKey();
      return;
    }
    TVEventControl.enableTVMenuKey();
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setScreen(parent);
      return true;
    });
    return () => subscription.remove();
  }, [screen]);

  return (
    <View style={styles.root}>
      {!catalog.isReady ? null : shown.name === "home" ? (
        <HomeScreen
          onOpenConnections={() => setScreen({ name: "connections" })}
          onOpenEnvironment={(environmentId) => setScreen({ name: "environment", environmentId })}
        />
      ) : shown.name === "connections" ? (
        <ConnectionsScreen
          onOpenEnvironment={(environmentId) => setScreen({ name: "environment", environmentId })}
          onSignIn={() => setScreen({ name: "signIn" })}
        />
      ) : shown.name === "signIn" ? (
        <SignInScreen onSignedIn={() => setScreen({ name: "connections" })} />
      ) : (
        <EnvironmentScreen
          key={shown.environmentId}
          environmentId={shown.environmentId}
          onBack={() => setScreen({ name: "home" })}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
});
