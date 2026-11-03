import { resolvePortalAccess } from "@t3tools/client-runtime/portal-user";

import { useJiraCapabilities, useJiraEnvironmentId } from "../../state/jira";
import { usePortalSession } from "../../state/portal";

/**
 * Whether to offer the Account page: a portal user signed in through Entra, on a server where
 * Jira personal tokens are available. The page only holds the Jira card for now.
 */
export function useCanOpenAccountSettings(): boolean {
  const session = usePortalSession();
  const capabilities = useJiraCapabilities(useJiraEnvironmentId());
  return (
    session !== null &&
    resolvePortalAccess(session).kind === "signed-in" &&
    capabilities?.personalTokens === true
  );
}
