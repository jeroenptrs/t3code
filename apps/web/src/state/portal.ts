import { useAtomValue } from "@effect/atom-react";
import { selectPortalEnvironmentId } from "@t3tools/client-runtime/portal-user";
import type { AuthSessionState, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSummaries } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentSession } from "./session";

const sessionOrNull = (result: AsyncResult.AsyncResult<AuthSessionState, unknown>) =>
  result._tag === "Failure" ? null : AsyncResult.getOrElse(result, () => null);

/**
 * Fork-only. The portal is the connected environment with Entra sign-in on. Jira, Insights,
 * Users and Account read through it, so a client with no portal connected shows none of them.
 */
const portalEnvironmentIdAtom = Atom.make((get) => {
  const primary = get(primaryEnvironmentIdAtom);
  const connected = get(environmentSummaries.connectedEnvironmentIdsAtom);
  const ids = primary === null ? connected : [primary, ...connected.filter((id) => id !== primary)];
  return selectPortalEnvironmentId(
    ids.map((environmentId) => ({
      environmentId,
      session: sessionOrNull(get(environmentSession.sessionStateAtom(environmentId))),
    })),
  );
}).pipe(Atom.withLabel("web-portal-environment-id"));

const NO_PORTAL_SESSION_ATOM = Atom.make(AsyncResult.initial<AuthSessionState>()).pipe(
  Atom.withLabel("web-portal-session:none"),
);

export function usePortalEnvironmentId(): EnvironmentId | null {
  return useAtomValue(portalEnvironmentIdAtom);
}

export function readPortalEnvironmentId(): EnvironmentId | null {
  return appAtomRegistry.get(portalEnvironmentIdAtom);
}

/** This client's session on the portal; null while there is none. */
export function usePortalSession(): AuthSessionState | null {
  const environmentId = usePortalEnvironmentId();
  return sessionOrNull(
    useAtomValue(
      environmentId === null
        ? NO_PORTAL_SESSION_ATOM
        : environmentSession.sessionStateAtom(environmentId),
    ),
  );
}
