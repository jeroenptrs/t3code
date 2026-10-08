import { PORTAL_USER_ROLE_LABELS, portalUserLabel } from "@t3tools/client-runtime/portal-user";
import { useRouteContext } from "@tanstack/react-router";
import { LogOutIcon, UserRoundIcon } from "lucide-react";

import { usePrimarySessionState } from "../../environments/primary";
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

/** The signed-in Entra user and sign-out. Renders nothing outside portal sign-in. */
export function PortalUserMenu() {
  const portal = useRouteContext({
    from: "__root__",
    select: (context) =>
      context.authGateState.status === "authenticated" && context.authGateState.portal === true,
  });
  return portal ? <SignedInPortalUserMenu /> : null;
}

function SignedInPortalUserMenu() {
  const user = usePrimarySessionState().data?.user ?? null;
  const { signOut, isSigningOut } = usePortalSignOut();
  if (user === null) return null;
  const label = portalUserLabel(user);

  return (
    <SidebarMenuItem className="ms-auto shrink-0">
      <Menu>
        <MenuTrigger
          render={<SidebarMenuButton aria-label={`Signed in as ${label}`} size="icon" />}
        >
          <UserRoundIcon />
        </MenuTrigger>
        <MenuPopup side="top" align="start">
          <MenuGroup>
            <MenuGroupLabel>
              <span className="block truncate text-foreground">{label}</span>
              {user.email && user.email !== label ? (
                <span className="block truncate font-normal">{user.email}</span>
              ) : null}
              {user.role ? (
                <span className="block font-normal">{PORTAL_USER_ROLE_LABELS[user.role]}</span>
              ) : null}
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
