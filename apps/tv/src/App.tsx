import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { BackHandler, Linking, StatusBar, StyleSheet, TVEventControl, View } from "react-native";

import { colors } from "./components/theme";
import { SignInScreen } from "./features/cloud/SignInScreen";
import { startDevLaunch } from "./lib/devLaunch";
import { parseTvLink } from "./lib/links";
import { INITIAL_STACK, shownStack, stackReducer, topOf, type Route } from "./navigation/stack";
import { TvNavigationContext, type TvNavigation } from "./navigation/TvNavigation";
import { ConnectionsScreen } from "./screens/ConnectionsScreen";
import { MainScreen, type MainScreenHandle } from "./screens/MainScreen";
import { TerminalScreen } from "./screens/TerminalScreen";
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
  const canGoBack = shown.length > 1;
  const [environmentFilter, setEnvironmentFilter] = useState<EnvironmentId | null>(null);
  const [inConversation, setInConversation] = useState(false);
  const main = useRef<MainScreenHandle>(null);

  const push = useCallback((route: Route) => dispatch({ type: "push", route }), []);
  const back = useCallback(() => dispatch({ type: "back" }), []);
  const navigation = useMemo(
    (): TvNavigation => ({
      push,
      back,
      openTerminal: (thread, terminalId) =>
        push({ name: "terminal", ...thread, ...(terminalId === undefined ? {} : { terminalId }) }),
    }),
    [back, push],
  );
  // Environments are a sidebar filter now; opening one shows the main view filtered to it.
  const openEnvironment = useCallback((environmentId: EnvironmentId) => {
    setEnvironmentFilter(environmentId);
    dispatch({ type: "reset", routes: INITIAL_STACK });
  }, []);

  useEffect(() => {
    const open = (url: string | null | undefined) => {
      const link = url ? parseTvLink(url) : null;
      if (link === null) return;
      if (link.kind === "environment") {
        openEnvironment(link.environmentId);
        return;
      }
      dispatch({ type: "reset", routes: [{ name: "home" }, { name: "connections" }] });
      openPairingLink({ host: link.host, code: link.code });
    };
    void Linking.getInitialURL().then(open);
    const subscription = Linking.addEventListener("url", (event) => open(event.url));
    const stopDevLaunch = startDevLaunch({
      openEnvironment,
      openHome: () => dispatch({ type: "close", name: "connections" }),
    });
    return () => {
      subscription.remove();
      stopDevLaunch();
    };
  }, [openEnvironment]);

  // tvOS exits on Menu unless the root holds the recognizer enableTVMenuKey adds; hold it while
  // Menu can go back a route or to the sidebar. A full-screen image's Modal has its own; its
  // focus counts as the conversation's, so this never re-enables (adding a second) while open.
  const menuReturnsToSidebar = !canGoBack && top.name === "home" && inConversation;
  const menuHandled = canGoBack || menuReturnsToSidebar;
  useEffect(() => {
    if (!menuHandled) {
      TVEventControl.disableTVMenuKey();
      return;
    }
    TVEventControl.enableTVMenuKey();
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (canGoBack) back();
      else main.current?.focusSidebar();
      return true;
    });
    return () => subscription.remove();
  }, [back, canGoBack, menuHandled]);

  if (!catalog.isReady) return <View style={styles.root} />;
  return (
    <TvNavigationContext value={navigation}>
      <View style={styles.root}>
        {shown[0].name === "home" ? (
          <MainScreen
            ref={main}
            hidden={top.name !== "home"}
            environmentFilter={environmentFilter}
            onEnvironmentFilterChange={setEnvironmentFilter}
            onOpenConnections={() => push({ name: "connections" })}
            onConversationFocusChange={setInConversation}
          />
        ) : null}
        {top.name === "connections" ? (
          <ConnectionsScreen
            onBack={canGoBack ? back : null}
            onOpenEnvironment={openEnvironment}
            onSignIn={() => push({ name: "signIn" })}
          />
        ) : top.name === "signIn" ? (
          <SignInScreen onSignedIn={back} />
        ) : top.name === "terminal" ? (
          <TerminalScreen
            key={`${top.environmentId}:${top.threadId}:${top.terminalId ?? ""}`}
            environmentId={top.environmentId}
            threadId={top.threadId}
            {...(top.terminalId === undefined ? {} : { terminalId: top.terminalId })}
            onClose={back}
          />
        ) : null}
      </View>
    </TvNavigationContext>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
});
