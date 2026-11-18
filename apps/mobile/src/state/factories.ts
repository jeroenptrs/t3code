import { useAtomValue } from "@effect/atom-react";
import { createNeedsYouSelector, needsYouListInputs } from "@t3tools/client-runtime/factories";
import { canManageFactories, canReadFactories } from "@t3tools/client-runtime/portal-user";
import { createFactoriesEnvironmentAtoms } from "@t3tools/client-runtime/state/factories";
import type { EnvironmentId, FactoryId, WorkItemSummary } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { connectedEnvironmentIdsAtom } from "./presentation";
import { environmentSession } from "./session";
import { environmentThreadShells } from "./threads";

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

export interface FactoryAccess {
  /** False until the environment's session first answers, so nothing flashes in and out. */
  readonly loaded: boolean;
  readonly canRead: boolean;
  readonly canManage: boolean;
}

export function useFactoryAccess(environmentId: EnvironmentId): FactoryAccess {
  const result = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const session = result._tag === "Failure" ? null : AsyncResult.getOrElse(result, () => null);
  return {
    loaded: result._tag !== "Initial",
    canRead: canReadFactories(session),
    canManage: canManageFactories(session),
  };
}

const NO_ITEMS: ReadonlyArray<WorkItemSummary> = [];

/** Rows only change when an item or its run thread's settled or archived state does. */
export const factoryNeedsYouAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((factoryId: FactoryId) => {
    const select = createNeedsYouSelector();
    const inputs = needsYouListInputs(factoryId);
    return Atom.make((get) => {
      const list = (input: (typeof inputs)[keyof typeof inputs]) =>
        AsyncResult.getOrElse(
          get(factoriesEnvironment.workItems({ environmentId, input })),
          () => null,
        )?.workItems ?? NO_ITEMS;
      return select({
        environmentId,
        waiting: list(inputs.waiting),
        failed: list(inputs.failed),
        shells: get(environmentThreadShells.threadShellsAtom),
      });
    }).pipe(Atom.withLabel(`mobile-factory-needs-you:${environmentId}:${factoryId}`));
  }),
);
