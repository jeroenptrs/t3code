import { useAtomValue } from "@effect/atom-react";
import { canManageInsights, canReadInsights } from "@t3tools/client-runtime/portal-user";
import { createInsightsEnvironmentAtoms } from "@t3tools/client-runtime/state/insights";
import type { AuthSessionState, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentIds, usePrimaryEnvironmentId } from "./environments";
import { environmentSession } from "./session";

export const insightsEnvironment = createInsightsEnvironmentAtoms(connectionAtomRuntime);

/**
 * The environment Insights reads and configures: the primary server, or the first known one where
 * the client has no primary, such as the hosted web app. Same choice as the Jira pages.
 */
export function useInsightsEnvironmentId(): EnvironmentId | null {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentIds = useEnvironmentIds();
  return primaryEnvironmentId ?? environmentIds[0] ?? null;
}

const NO_SESSION_ATOM = Atom.make(AsyncResult.initial<AuthSessionState>()).pipe(
  Atom.withLabel("web-insights:session:none"),
);

interface InsightsAccess {
  /** False until the environment's session first answers, so nothing flashes in and out. */
  readonly loaded: boolean;
  readonly canRead: boolean;
  readonly canManage: boolean;
}

export function useInsightsAccess(environmentId: EnvironmentId | null): InsightsAccess {
  const result = useAtomValue(
    environmentId === null ? NO_SESSION_ATOM : environmentSession.sessionStateAtom(environmentId),
  );
  const session = result._tag === "Failure" ? null : Option.getOrNull(AsyncResult.value(result));
  return {
    loaded: result._tag !== "Initial",
    canRead: canReadInsights(session),
    canManage: canManageInsights(session),
  };
}

/** Whether to offer Insights entry points at all: Readers and Operators see none. */
export function useCanReadInsights(): boolean {
  return useInsightsAccess(useInsightsEnvironmentId()).canRead;
}
