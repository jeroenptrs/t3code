import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { BackHandler, Linking, StatusBar, StyleSheet, TVEventControl, View } from "react-native";

import { colors } from "./components/theme";
import { SignInScreen } from "./features/cloud/SignInScreen";
import { startDevLaunch } from "./lib/devLaunch";
import { parseTvLink } from "./lib/links";
import { ConnectionsScreen } from "./screens/ConnectionsScreen";
import { EnvironmentScreen } from "./screens/EnvironmentScreen";
import { tvAtomRegistry } from "./state/atom-registry";
import { submitPairingForm, updatePairingForm } from "./state/pairing-form";

export { setTvCloudSession, type TvCloudSessionInput } from "./connection/cloud-session";

type Screen =
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

function Screens() {
  const [screen, setScreen] = useState<Screen>({ name: "connections" });

  useEffect(() => {
    const open = (url: string | null | undefined) => {
      const link = url ? parseTvLink(url) : null;
      if (link === null) return;
      if (link.kind === "environment") {
        setScreen({ name: "environment", environmentId: link.environmentId });
        return;
      }
      setScreen({ name: "connections" });
      updatePairingForm({ host: link.host, code: link.code });
      void submitPairingForm();
    };
    void Linking.getInitialURL().then(open);
    const subscription = Linking.addEventListener("url", (event) => open(event.url));
    const stopDevLaunch = startDevLaunch((environmentId) =>
      setScreen({ name: "environment", environmentId }),
    );
    return () => {
      subscription.remove();
      stopDevLaunch();
    };
  }, []);

  // The remote's Menu button exits the app unless something handles it; on a nested screen it
  // goes back instead.
  useEffect(() => {
    if (screen.name === "connections") {
      TVEventControl.disableTVMenuKey();
      return;
    }
    TVEventControl.enableTVMenuKey();
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setScreen({ name: "connections" });
      return true;
    });
    return () => subscription.remove();
  }, [screen.name]);

  return (
    <View style={styles.root}>
      {screen.name === "connections" ? (
        <ConnectionsScreen
          onOpenEnvironment={(environmentId) => setScreen({ name: "environment", environmentId })}
          onSignIn={() => setScreen({ name: "signIn" })}
        />
      ) : screen.name === "signIn" ? (
        <SignInScreen onSignedIn={() => setScreen({ name: "connections" })} />
      ) : (
        <EnvironmentScreen
          environmentId={screen.environmentId}
          onBack={() => setScreen({ name: "connections" })}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
});
