import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useReducer, type ComponentType, type ReactNode } from "react";
import { BackHandler, Linking, StatusBar, StyleSheet, TVEventControl, View } from "react-native";

import { colors } from "./components/theme";
import { SignInScreen } from "./features/cloud/SignInScreen";
import { startDevLaunch } from "./lib/devLaunch";
import { parseTvLink } from "./lib/links";
import {
  INITIAL_STACK,
  shownStack,
  stackReducer,
  topOf,
  type Route,
  type ThreadRef,
} from "./navigation/stack";
import { ConnectionsScreen } from "./screens/ConnectionsScreen";
import { EnvironmentScreen } from "./screens/EnvironmentScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { ThreadScreen } from "./screens/ThreadScreen";
import { tvAtomRegistry } from "./state/atom-registry";
import { environmentCatalog } from "./state/environments";
import { openPairingLink } from "./state/pairing-form";

export { setTvCloudSession, type TvCloudSessionInput } from "./connection/cloud-session";

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
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const [stack, dispatch] = useReducer(stackReducer, INITIAL_STACK);
  const shown = shownStack(stack, !catalog.isReady || catalog.entries.size > 0);
  const top = topOf(shown);
  // A thread shows over the list it was opened from, which stays mounted to keep its place.
  const base =
    top.name === "thread" ? (shown.findLast((route) => route.name !== "thread") ?? top) : top;
  const canGoBack = shown.length > 1;

  const push = useCallback((route: Route) => dispatch({ type: "push", route }), []);
  const back = useCallback(() => dispatch({ type: "back" }), []);
  const openEnvironment = useCallback(
    (environmentId: EnvironmentId) => push({ name: "environment", environmentId }),
    [push],
  );
  const openThread = useCallback(
    (thread: ThreadRef, siblings: ReadonlyArray<ThreadRef>) =>
      push({ name: "thread", thread, siblings }),
    [push],
  );

  useEffect(() => {
    const open = (url: string | null | undefined) => {
      const link = url ? parseTvLink(url) : null;
      if (link === null) return;
      if (link.kind === "environment") {
        dispatch({
          type: "reset",
          routes: [{ name: "home" }, { name: "environment", environmentId: link.environmentId }],
        });
        return;
      }
      dispatch({ type: "reset", routes: [{ name: "home" }, { name: "connections" }] });
      openPairingLink({ host: link.host, code: link.code });
    };
    void Linking.getInitialURL().then(open);
    const subscription = Linking.addEventListener("url", (event) => open(event.url));
    const stopDevLaunch = startDevLaunch({
      openEnvironment: (environmentId) =>
        dispatch({
          type: "reset",
          routes: [{ name: "home" }, { name: "environment", environmentId }],
        }),
      openHome: () => dispatch({ type: "close", name: "connections" }),
    });
    return () => {
      subscription.remove();
      stopDevLaunch();
    };
  }, []);

  // tvOS exits the app on Menu (and the newer remote's Back) unless the root view holds a Menu
  // recognizer, which enableTVMenuKey adds. Hold it whenever there is somewhere to go back to.
  // A full-screen image is a Modal with its own native Menu recognizer, so this never changes
  // while one is open: enabling again would add a second recognizer to the modal's view.
  useEffect(() => {
    if (!canGoBack) {
      TVEventControl.disableTVMenuKey();
      return;
    }
    TVEventControl.enableTVMenuKey();
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      back();
      return true;
    });
    return () => subscription.remove();
  }, [back, canGoBack]);

  if (!catalog.isReady) return <View style={styles.root} />;
  return (
    <View style={styles.root}>
      {top.name === "thread" ? (
        <ThreadScreen
          route={top}
          onBack={back}
          onOpenSibling={(thread) => dispatch({ type: "replace", route: { ...top, thread } })}
        />
      ) : null}
      {base.name === "home" ? (
        <HomeScreen
          hidden={top !== base}
          onOpenConnections={() => push({ name: "connections" })}
          onOpenEnvironment={openEnvironment}
          onOpenThread={openThread}
        />
      ) : base.name === "connections" ? (
        <ConnectionsScreen
          onBack={canGoBack ? back : null}
          onOpenEnvironment={openEnvironment}
          onSignIn={() => push({ name: "signIn" })}
        />
      ) : base.name === "signIn" ? (
        <SignInScreen onSignedIn={back} />
      ) : base.name === "environment" ? (
        <EnvironmentScreen
          key={base.environmentId}
          hidden={top !== base}
          environmentId={base.environmentId}
          onBack={back}
          onOpenThread={openThread}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
});
