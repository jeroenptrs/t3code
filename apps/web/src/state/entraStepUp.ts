import {
  createEntraStepUpCommand,
  createEntraStepUpSignOutCommand,
} from "@t3tools/client-runtime/state/entraStepUp";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";

const startStepUp = createEntraStepUpCommand(connectionAtomRuntime);
const signOutStepUp = createEntraStepUpSignOutCommand(connectionAtomRuntime);

/**
 * Opens Microsoft sign-in for this client's session on `environmentId`. When it
 * finishes, the environment closes the socket and the reconnect reads the user.
 */
export async function signInWithMicrosoftOn(environmentId: EnvironmentId): Promise<void> {
  // A browser blocks a tab opened after an await, so open it now and point it at the URL later.
  const tab = window.desktopBridge ? null : window.open("", "_blank");
  const result = await startStepUp.run(appAtomRegistry, { environmentId, input: undefined });
  if (result._tag !== "Success") {
    tab?.close();
    throw squashAtomCommandFailure(result);
  }
  if (tab) {
    tab.opener = null;
    tab.location.href = result.value;
    return;
  }
  await readLocalApi()?.shell.openExternal(result.value);
}

/** Drops the Microsoft user from this client's session on `environmentId`. */
export async function signOutOfMicrosoftOn(environmentId: EnvironmentId): Promise<void> {
  const result = await signOutStepUp.run(appAtomRegistry, { environmentId, input: undefined });
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
}
