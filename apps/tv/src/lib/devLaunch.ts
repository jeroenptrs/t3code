import type { EnvironmentId } from "@t3tools/contracts";

import { tvAtomRegistry } from "../state/atom-registry";
import { environmentSummaries } from "../state/environments";
import { submitPairingForm } from "../state/pairing-form";

/**
 * Dev-only launch actions for a simulator nothing can press remote buttons on.
 * EXPO_PUBLIC_TV_DEV_AUTO_PAIR=1 submits the prefilled pairing form at launch;
 * EXPO_PUBLIC_TV_DEV_OPEN_ENVIRONMENT=1 opens the first environment that connects;
 * EXPO_PUBLIC_TV_DEV_OPEN_HOME=1 opens Home once one connects, even from a pairing link.
 */
export function startDevLaunch(actions: {
  readonly openEnvironment: (environmentId: EnvironmentId) => void;
  readonly openHome: () => void;
}) {
  if (!__DEV__) return () => {};
  if (process.env.EXPO_PUBLIC_TV_DEV_AUTO_PAIR === "1") void submitPairingForm();
  const openEnvironment = process.env.EXPO_PUBLIC_TV_DEV_OPEN_ENVIRONMENT === "1";
  if (!openEnvironment && process.env.EXPO_PUBLIC_TV_DEV_OPEN_HOME !== "1") return () => {};
  let opened = false;
  return tvAtomRegistry.subscribe(
    environmentSummaries.environmentsAtom,
    (environments) => {
      const connected = environments.find((entry) => entry.connectionState === "connected");
      if (opened || connected === undefined) return;
      opened = true;
      if (openEnvironment) actions.openEnvironment(connected.environmentId);
      else actions.openHome();
    },
    { immediate: true },
  );
}
