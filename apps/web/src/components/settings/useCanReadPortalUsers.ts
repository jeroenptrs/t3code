import { canReadPortalUsers } from "@t3tools/client-runtime/portal-user";

import { usePortalSession } from "../../state/portal";

/** Whether to offer the Users page: the portal is connected and this session has `access:read`. */
export function useCanReadPortalUsers(): boolean {
  return canReadPortalUsers(usePortalSession());
}
