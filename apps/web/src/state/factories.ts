import { useAtomValue } from "@effect/atom-react";
import { canManageFactories, canReadFactories } from "@t3tools/client-runtime/portal-user";
import { createFactoriesEnvironmentAtoms } from "@t3tools/client-runtime/state/factories";
import {
  FactoryError,
  type AuthSessionState,
  type EnvironmentId,
  type FactorySummary,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSummaries } from "./presentation";
import { environmentSession } from "./session";

export const factoriesEnvironment = createFactoriesEnvironmentAtoms(connectionAtomRuntime);

export interface FactoryEnvironment {
  readonly environmentId: EnvironmentId;
  readonly canManage: boolean;
  /** Null until the list answers, and where this session cannot list factories or the server has none. */
  readonly factories: ReadonlyArray<FactorySummary> | null;
}

const sessionOrNull = (result: AsyncResult.AsyncResult<AuthSessionState, unknown>) =>
  result._tag === "Failure" ? null : AsyncResult.getOrElse(result, () => null);

/**
 * Every connected environment with its factories. Each reads through its own session, so a
 * desktop app with no local server still lists what its remote environments hold.
 */
const factoryEnvironmentsAtom = Atom.make((get): ReadonlyArray<FactoryEnvironment> =>
  get(environmentSummaries.connectedEnvironmentIdsAtom).map((environmentId) => {
    const session = sessionOrNull(get(environmentSession.sessionStateAtom(environmentId)));
    const list = canReadFactories(session)
      ? get(factoriesEnvironment.list({ environmentId, input: {} }))
      : null;
    return {
      environmentId,
      canManage: canManageFactories(session),
      factories:
        list === null ? null : (AsyncResult.getOrElse(list, () => null)?.factories ?? null),
    };
  }),
).pipe(Atom.withLabel("web-factory-environments"));

export function useFactoryEnvironments(): ReadonlyArray<FactoryEnvironment> {
  return useAtomValue(factoryEnvironmentsAtom);
}

const NO_SESSION_ATOM = Atom.make(AsyncResult.initial<AuthSessionState>()).pipe(
  Atom.withLabel("web-factories:session:none"),
);

export interface FactoryAccess {
  /** False until the environment's session first answers, so nothing flashes in and out. */
  readonly loaded: boolean;
  readonly canRead: boolean;
  readonly canManage: boolean;
}

export function useFactoryAccess(environmentId: EnvironmentId | null): FactoryAccess {
  const result = useAtomValue(
    environmentId === null ? NO_SESSION_ATOM : environmentSession.sessionStateAtom(environmentId),
  );
  const session = sessionOrNull(result);
  return {
    loaded: result._tag !== "Initial",
    canRead: canReadFactories(session),
    canManage: canManageFactories(session),
  };
}

const isFactoryError = Schema.is(FactoryError);

/** The factory error behind a failed read or save, or null when the failure was not one. */
export function factoryErrorOf(failure: unknown): FactoryError | null {
  return isFactoryError(failure) ? failure : null;
}
