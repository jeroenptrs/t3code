import { canReadFactories } from "@t3tools/client-runtime/portal-user";
import { createFactoriesEnvironmentAtoms } from "@t3tools/client-runtime/state/factories";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { connectedEnvironmentIdsAtom } from "./presentation";
import { environmentSession } from "./session";

export const factoriesEnvironment = createFactoriesEnvironmentAtoms(connectionAtomRuntime);

/** Each connected environment whose session may read factories, with the factories it reported. */
export const connectedFactoryListsAtom = Atom.make((get) =>
  get(connectedEnvironmentIdsAtom).flatMap((environmentId) => {
    const session = get(environmentSession.sessionStateAtom(environmentId));
    if (session._tag === "Failure" || !canReadFactories(AsyncResult.getOrElse(session, () => null)))
      return [];
    const list = get(factoriesEnvironment.list({ environmentId, input: {} }));
    return [{ environmentId, factories: AsyncResult.getOrElse(list, () => null)?.factories ?? [] }];
  }),
).pipe(Atom.withLabel("mobile-factories:connected-lists"));
