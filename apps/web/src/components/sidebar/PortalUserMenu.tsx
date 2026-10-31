import { useAtomValue } from "@effect/atom-react";
import {
  linkedPortalAccess,
  PORTAL_USER_ROLE_LABELS,
  portalUserLabel,
} from "@t3tools/client-runtime/portal-user";
import type { AuthSessionUser, EnvironmentId } from "@t3tools/contracts";
import { useRouteContext } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { LogInIcon, LogOutIcon, UserRoundIcon } from "lucide-react";
import { Fragment } from "react";

import { usePrimarySessionState } from "../../environments/primary";
import { environmentIdsKey } from "../../state/environmentAtomList";
import { signInWithMicrosoftOn, signOutOfMicrosoftOn } from "../../state/entraStepUp";
import { useConnectedEnvironmentIds, useEnvironmentIdentities } from "../../state/environments";
import { environmentSessionStatesAtom } from "../../state/session";
import { usePortalSignOut } from "../auth/PortalAccessSurface";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { toastManager } from "../ui/toast";

/**
 * The signed-in Entra user and sign-out. A browser signed in through the
 * portal shows its user; otherwise, connected environments whose session can
 * sign in with Microsoft (a T3 Connect link, say) are listed with their user
 * or a way to sign in.
 */
export function PortalUserMenu() {
  const portal = useRouteContext({
    from: "__root__",
    select: (context) =>
      context.authGateState.status === "authenticated" && context.authGateState.portal === true,
  });
  return portal ? <SignedInPortalUserMenu /> : <LinkedPortalUserMenu />;
}

function UserLabel({ user }: { readonly user: AuthSessionUser }) {
  const label = portalUserLabel(user);
  return (
    <>
      <span className="block truncate text-foreground">{label}</span>
      {user.email && user.email !== label ? (
        <span className="block truncate font-normal">{user.email}</span>
      ) : null}
      {user.role ? (
        <span className="block font-normal">{PORTAL_USER_ROLE_LABELS[user.role]}</span>
      ) : null}
    </>
  );
}

function SignedInPortalUserMenu() {
  const user = usePrimarySessionState().data?.user ?? null;
  const { signOut, isSigningOut } = usePortalSignOut();
  if (user === null) return null;

  return (
    <SidebarMenuItem className="ms-auto shrink-0">
      <Menu>
        <MenuTrigger
          render={
            <SidebarMenuButton aria-label={`Signed in as ${portalUserLabel(user)}`} size="icon" />
          }
        >
          <UserRoundIcon />
        </MenuTrigger>
        <MenuPopup side="top" align="start">
          <MenuGroup>
            <MenuGroupLabel>
              <UserLabel user={user} />
            </MenuGroupLabel>
          </MenuGroup>
          <MenuSeparator />
          <MenuItem disabled={isSigningOut} onClick={() => void signOut()}>
            <LogOutIcon />
            {isSigningOut ? "Signing out…" : "Sign out"}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
}

const runOrToast = (action: () => Promise<void>, title: string) => {
  action().catch((error: unknown) =>
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The request failed.",
    }),
  );
};

function LinkedPortalUserMenu() {
  const environmentIds = useConnectedEnvironmentIds();
  const identities = useEnvironmentIdentities();
  const states = useAtomValue(environmentSessionStatesAtom(environmentIdsKey(environmentIds)));
  const linked = environmentIds.flatMap((environmentId, index) => {
    const session = AsyncResult.getOrElse(states[index]!, () => null);
    const access = linkedPortalAccess(session);
    if (access === null) return [];
    return [
      {
        environmentId,
        label:
          identities.find((identity) => identity.environmentId === environmentId)?.label ??
          "Environment",
        user: session?.user ?? null,
      },
    ];
  });
  if (linked.length === 0) return null;
  const needsSignIn = linked.some((entry) => entry.user === null);

  return (
    <SidebarMenuItem className="ms-auto shrink-0">
      <Menu>
        <MenuTrigger
          render={
            <SidebarMenuButton
              aria-label={needsSignIn ? "Sign in with Microsoft" : "Microsoft accounts"}
              size="icon"
            />
          }
        >
          {needsSignIn ? <LogInIcon /> : <UserRoundIcon />}
        </MenuTrigger>
        <MenuPopup side="top" align="start">
          {linked.map((entry, index) => (
            <Fragment key={entry.environmentId}>
              {index > 0 ? <MenuSeparator /> : null}
              <LinkedEnvironmentEntry {...entry} />
            </Fragment>
          ))}
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
}

function LinkedEnvironmentEntry({
  environmentId,
  label,
  user,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly user: AuthSessionUser | null;
}) {
  return (
    <MenuGroup>
      <MenuGroupLabel>
        <span className="block truncate font-normal">{label}</span>
        {user ? <UserLabel user={user} /> : null}
      </MenuGroupLabel>
      {user ? (
        <MenuItem
          onClick={() =>
            runOrToast(() => signOutOfMicrosoftOn(environmentId), "Could not sign out")
          }
        >
          <LogOutIcon />
          Sign out
        </MenuItem>
      ) : (
        <MenuItem
          onClick={() =>
            runOrToast(
              () => signInWithMicrosoftOn(environmentId),
              "Could not start Microsoft sign-in",
            )
          }
        >
          <LogInIcon />
          Sign in with Microsoft
        </MenuItem>
      )}
    </MenuGroup>
  );
}
