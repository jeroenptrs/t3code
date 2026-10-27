import type { getClerkInstance } from "@clerk/expo";
import { createCloudAccountService } from "@t3tools/client-runtime/relay";

import { cleanUpTvCloudAccount, setTvCloudSession } from "../../connection/cloud-session";
import { readRelayClerkToken } from "./readClerkToken";

type ClerkInstance = ReturnType<typeof getClerkInstance>;

// The TV side of apps/mobile/src/features/cloud/cloudAccountService.ts. The service listens to
// the Clerk instance itself, so a session restored from the keychain at launch reaches the
// connection runtime without waiting for a React render. Without drafts, push registrations, or
// onboarding, sign-in installs the relay session and sign-out removes relay environments.
export const cloudAccountService = createCloudAccountService<ClerkInstance>({
  deactivate: () => setTvCloudSession(null),
  detach: () => setTvCloudSession(null),
  cleanUp: () => cleanUpTvCloudAccount(),
  activate: ({ accountId }) =>
    setTvCloudSession({ accountId, readClerkToken: readRelayClerkToken }),
});
