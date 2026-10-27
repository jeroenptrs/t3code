import { setManagedRelaySession } from "@t3tools/client-runtime/relay";

import { tvAtomRegistry } from "../state/atom-registry";

/**
 * What the cloud sign-in hands the connection runtime. `readClerkToken` returns a Clerk
 * session JWT for the relay's `t3-relay` audience, or null when signed out.
 */
export interface TvCloudSessionInput {
  readonly accountId: string;
  readonly readClerkToken: () => Promise<string | null>;
}

/**
 * Installs or clears the T3 Connect session. Until something calls this, the app has no cloud
 * session: relay environments report "sign in", and directly paired environments work.
 * Calling it again for the same account swaps the token reader without reconnecting.
 */
export function setTvCloudSession(input: TvCloudSessionInput | null): void {
  setManagedRelaySession(tvAtomRegistry, input);
}
