import { useAtomValue } from "@effect/atom-react";
import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@t3tools/client-runtime/state/vcs";
import type { AuthEnvironmentScope, EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../../connection/runtime";
import { tvAtomRegistry } from "../../state/atom-registry";
import { environmentSession } from "../../state/environments";
import { awaitSessionScope, sessionResultGrants } from "./sessionScope";

// The source control atoms apps/mobile/src/state/vcs.ts wires up.
export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);

/** Whether this connection's session grants `scope`, as mobile's useEnvironmentScope reads it. */
export function useEnvironmentScope(
  environmentId: EnvironmentId,
  scope: AuthEnvironmentScope,
): boolean {
  return sessionResultGrants(
    useAtomValue(environmentSession.sessionStateAtom(environmentId)),
    scope,
  );
}

/** Like readEnvironmentScope, but waits for a session that is still loading instead of denying. */
export function awaitEnvironmentScope(
  environmentId: EnvironmentId,
  scope: AuthEnvironmentScope,
): Promise<boolean> {
  return awaitSessionScope(
    tvAtomRegistry,
    environmentSession.sessionStateAtom(environmentId),
    scope,
  );
}

export function readEnvironmentScope(
  environmentId: EnvironmentId,
  scope: AuthEnvironmentScope,
): boolean {
  return sessionResultGrants(
    tvAtomRegistry.get(environmentSession.sessionStateAtom(environmentId)),
    scope,
  );
}
