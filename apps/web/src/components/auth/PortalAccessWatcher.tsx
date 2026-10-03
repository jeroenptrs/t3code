import { useAtomValue } from "@effect/atom-react";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRouter, useRouteContext } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useRef } from "react";

import { portalGateChanged } from "../../authGate";
import { environmentCatalog } from "../../connection/catalog";
import {
  portalGateStateFromSession,
  refreshPrimarySessionState,
  resetServerAuthGate,
  usePrimarySessionState,
} from "../../environments/primary";
import { usePrimaryEnvironmentId } from "../../state/environments";

/**
 * The server closes a portal user's socket when their access changes. The
 * client reconnects on its own, but the root gate was resolved once; this
 * re-reads the session on each reconnect (or failed attempt) and re-runs the
 * gate when the user was signed out, disabled, or sent back to pending.
 * Role changes keep the gate and refresh the scopes settings read.
 */
export function PortalAccessWatcher() {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId === null ? null : (
    <PrimaryPortalAccessWatcher environmentId={environmentId} />
  );
}

function PrimaryPortalAccessWatcher({ environmentId }: { environmentId: EnvironmentId }) {
  const router = useRouter();
  const authGateState = useRouteContext({
    from: "__root__",
    select: (context) => context.authGateState,
  });
  const connection = Option.getOrElse(
    AsyncResult.value(useAtomValue(environmentCatalog.stateAtom(environmentId))),
    () => AVAILABLE_CONNECTION_STATE,
  );
  // A new key means the socket dropped (each retry) or came back.
  const reconnectKey =
    connection.phase === "backoff" || connection.phase === "blocked"
      ? `down:${connection.attempt}`
      : `up:${connection.generation}`;
  const lastReconnectKeyRef = useRef(reconnectKey);
  useEffect(() => {
    if (lastReconnectKeyRef.current === reconnectKey) return;
    lastReconnectKeyRef.current = reconnectKey;
    refreshPrimarySessionState();
  }, [reconnectKey]);

  const session = usePrimarySessionState().data;
  useEffect(() => {
    if (!session) return;
    if (portalGateChanged(authGateState, portalGateStateFromSession(session, null))) {
      resetServerAuthGate();
      void router.invalidate();
    }
  }, [authGateState, router, session]);

  return null;
}
