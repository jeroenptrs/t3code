import type { AuthUser, AuthUserAccessChange, AuthUserId, AuthUserRole } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { runPrimaryHttp } from "../../lib/runtime";
import { PrimaryEnvironmentHttpClient } from "./httpClient";

/*
 * Portal user administration on the primary environment. Failures reject with
 * the typed environment error so `describeUserAdminError` can name the reason.
 */

export function listPortalUsers(): Promise<ReadonlyArray<AuthUser>> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.auth.users({ headers: {} })),
    ),
  );
}

export function listPortalUserAccessChanges(
  userId: AuthUserId,
): Promise<ReadonlyArray<AuthUserAccessChange>> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.auth.userAccessChanges({ headers: {}, query: { userId } })),
    ),
  );
}

export type PortalUserMutation =
  | { readonly type: "approve"; readonly userId: AuthUserId; readonly role: AuthUserRole }
  | { readonly type: "change-role"; readonly userId: AuthUserId; readonly role: AuthUserRole }
  | { readonly type: "disable"; readonly userId: AuthUserId }
  | { readonly type: "enable"; readonly userId: AuthUserId; readonly role?: AuthUserRole };

export function mutatePortalUser(mutation: PortalUserMutation): Promise<AuthUser> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => {
        switch (mutation.type) {
          case "approve":
            return client.auth.approveUser({
              headers: {},
              payload: { userId: mutation.userId, role: mutation.role },
            });
          case "change-role":
            return client.auth.changeUserRole({
              headers: {},
              payload: { userId: mutation.userId, role: mutation.role },
            });
          case "disable":
            return client.auth.disableUser({ headers: {}, payload: { userId: mutation.userId } });
          case "enable":
            return client.auth.enableUser({
              headers: {},
              payload: {
                userId: mutation.userId,
                ...(mutation.role ? { role: mutation.role } : {}),
              },
            });
        }
      }),
    ),
  );
}

/** Resolves with how many sessions ended. */
export function revokePortalUserSessions(userId: AuthUserId): Promise<number> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.auth.revokeUserSessions({ headers: {}, payload: { userId } }),
      ),
      Effect.map((result) => result.revokedCount),
    ),
  );
}
