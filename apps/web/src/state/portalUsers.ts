import {
  createPortalUserCommands,
  PortalUnavailableError,
  type PortalUserMutation,
} from "@t3tools/client-runtime/state/portalUsers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AuthUser, AuthUserAccessChange, AuthUserId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPortalEnvironmentId } from "./portal";

/*
 * Fork-only. Portal user administration on the connected portal. Failures reject with the typed
 * environment error so `describeUserAdminError` can name the reason.
 */

const commands = createPortalUserCommands(connectionAtomRuntime);

function portalEnvironmentId() {
  const environmentId = readPortalEnvironmentId();
  if (environmentId === null) throw new PortalUnavailableError();
  return environmentId;
}

export async function listPortalUsers(): Promise<ReadonlyArray<AuthUser>> {
  const environmentId = portalEnvironmentId();
  const result = await commands.list.run(appAtomRegistry, { environmentId, input: undefined });
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  return result.value;
}

export async function listPortalUserAccessChanges(
  userId: AuthUserId,
): Promise<ReadonlyArray<AuthUserAccessChange>> {
  const environmentId = portalEnvironmentId();
  const result = await commands.accessChanges.run(appAtomRegistry, {
    environmentId,
    input: userId,
  });
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  return result.value;
}

export async function mutatePortalUser(mutation: PortalUserMutation): Promise<AuthUser> {
  const environmentId = portalEnvironmentId();
  const result = await commands.mutate.run(appAtomRegistry, { environmentId, input: mutation });
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  return result.value;
}

/** Resolves with how many sessions ended. */
export async function revokePortalUserSessions(userId: AuthUserId): Promise<number> {
  const environmentId = portalEnvironmentId();
  const result = await commands.revokeSessions.run(appAtomRegistry, {
    environmentId,
    input: userId,
  });
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  return result.value;
}
