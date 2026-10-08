import { canReadPortalUsers } from "@t3tools/client-runtime/portal-user";

import { usePrimarySessionState } from "../../environments/primary";

/** Whether to offer the Users page: Entra sign-in is on and this session has `access:read`. */
export function useCanReadPortalUsers(): boolean {
  return canReadPortalUsers(usePrimarySessionState().data);
}
