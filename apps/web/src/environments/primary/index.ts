export {
  getPrimaryKnownEnvironment,
  resetPrimaryEnvironmentDescriptorForTests,
  resolveInitialPrimaryEnvironmentDescriptor,
  writePrimaryEnvironmentDescriptor,
} from "./context";

export {
  createServerPairingCredential,
  isPrimaryEnvironmentPairingCredentialRejectedError,
  peekPairingTokenFromUrl,
  portalGateStateFromSession,
  PrimaryEnvironmentPairingCredentialRejectedError,
  PrimaryEnvironmentRequestError,
  resetServerAuthGate,
  resolveInitialServerAuthGateState,
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  signOutPrimarySession,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
  takePairingTokenFromUrl,
  type ServerAuthGateState,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
  __resetServerAuthBootstrapForTests,
} from "./auth";

export { refreshPrimarySessionState, usePrimarySessionState } from "./sessionState";

export {
  DesktopEnvironmentBootstrapIncompleteError,
  isDesktopEnvironmentBootstrapIncompleteError,
  isPrimaryEnvironmentProtocolUnsupportedError,
  isPrimaryEnvironmentUrlInvalidError,
  PrimaryEnvironmentProtocolUnsupportedError,
  PrimaryEnvironmentUrlInvalidError,
  readPrimaryEnvironmentTarget,
  resolvePrimaryEnvironmentHttpUrl,
  isLoopbackHostname,
  type PrimaryEnvironmentTarget,
} from "./target";
