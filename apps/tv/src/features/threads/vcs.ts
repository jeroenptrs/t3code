import { useAtomValue } from "@effect/atom-react";
import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@t3tools/client-runtime/state/vcs";
import {
  sessionGrantsScope,
  type AuthEnvironmentScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { tvAtomRegistry } from "../../state/atom-registry";
import { environmentSession } from "../../state/environments";

// The source control atoms apps/mobile/src/state/vcs.ts wires up.
export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);

function grants(
  result: AsyncResult.AsyncResult<Parameters<typeof sessionGrantsScope>[0], unknown>,
  scope: AuthEnvironmentScope,
): boolean {
  const session = Option.getOrNull(AsyncResult.value(result));
  return result._tag !== "Failure" && session !== null && sessionGrantsScope(session, scope);
}

/** Whether this connection's session grants `scope`, as mobile's useEnvironmentScope reads it. */
export function useEnvironmentScope(
  environmentId: EnvironmentId,
  scope: AuthEnvironmentScope,
): boolean {
  return grants(useAtomValue(environmentSession.sessionStateAtom(environmentId)), scope);
}

export function readEnvironmentScope(
  environmentId: EnvironmentId,
  scope: AuthEnvironmentScope,
): boolean {
  return grants(tvAtomRegistry.get(environmentSession.sessionStateAtom(environmentId)), scope);
}
