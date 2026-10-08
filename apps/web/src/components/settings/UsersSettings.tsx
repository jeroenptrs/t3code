import type { AuthUser, AuthUserAccessChange, AuthUserId, AuthUserRole } from "@t3tools/contracts";
import {
  canManagePortalUsers,
  canReadPortalUsers,
  describeUserAccessActor,
  describeUserAccessChange,
  describeUserAdminError,
  PORTAL_USER_ROLE_DESCRIPTIONS,
  PORTAL_USER_ROLE_LABELS,
  PORTAL_USER_ROLES,
  PORTAL_USER_STATUS_LABELS,
  portalUserActions,
  portalUserLabel,
  sortPortalUsers,
} from "@t3tools/client-runtime/portal-user";
import * as DateTime from "effect/DateTime";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { usePrimarySessionState } from "../../environments/primary";
import {
  listPortalUserAccessChanges,
  listPortalUsers,
  mutatePortalUser,
  revokePortalUserSessions,
} from "../../environments/primary/users";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatTimestamp(value: DateTime.Utc): string {
  return timestampFormatter.format(DateTime.toDate(value));
}

const ROLE_ITEMS = PORTAL_USER_ROLES.map((role) => ({
  value: role,
  label: PORTAL_USER_ROLE_LABELS[role],
}));

/** The user list has no live push, so it loads on mount and after each change. */
function usePortalUsers() {
  const [users, setUsers] = useState<ReadonlyArray<AuthUser> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [revision, setRevision] = useState(0);

  const load = useCallback(
    () =>
      listPortalUsers()
        .then(
          (result) => {
            setUsers(result);
            setError(null);
          },
          (cause) => setError(describeUserAdminError(cause)),
        )
        .finally(() => {
          setIsLoading(false);
          setRevision((value) => value + 1);
        }),
    [],
  );
  const refresh = useCallback(async () => {
    setIsLoading(true);
    await load();
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  return { users, error, isLoading, refresh, revision };
}

export function UsersSettings() {
  const session = usePrimarySessionState();
  if (session.data === null) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">{session.error ?? "Loading your access…"}</p>
      </SettingsPageContainer>
    );
  }
  if (!canReadPortalUsers(session.data)) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          Managing users needs an administrator role on this environment.
        </p>
      </SettingsPageContainer>
    );
  }
  return (
    <PortalUsersList
      canManage={canManagePortalUsers(session.data)}
      currentUserId={session.data.user?.userId ?? null}
    />
  );
}

function PortalUsersList({
  canManage,
  currentUserId,
}: {
  readonly canManage: boolean;
  readonly currentUserId: AuthUserId | null;
}) {
  const { users, error, isLoading, refresh, revision } = usePortalUsers();
  const sorted = useMemo(() => sortPortalUsers(users ?? []), [users]);
  const pending = sorted.filter((user) => user.status === "pending");
  const others = sorted.filter((user) => user.status !== "pending");
  const labelForUser = useCallback(
    (userId: AuthUserId) => {
      const user = users?.find((candidate) => candidate.userId === userId);
      return user ? portalUserLabel(user) : null;
    },
    [users],
  );
  const refreshAction = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            disabled={isLoading}
            onClick={() => void refresh()}
            aria-label="Refresh users"
          >
            <RefreshIcon refreshing={isLoading} />
          </Button>
        }
      />
      <TooltipPopup side="top">Refresh users</TooltipPopup>
    </Tooltip>
  );
  const renderRow = (user: AuthUser) => (
    <PortalUserRow
      key={user.userId}
      user={user}
      isCurrentUser={user.userId === currentUserId}
      canManage={canManage}
      historyRevision={revision}
      labelForUser={labelForUser}
      onChanged={refresh}
    />
  );

  return (
    <SettingsPageContainer width="wide">
      {error ? <p className="px-3 text-sm text-destructive-foreground sm:px-4">{error}</p> : null}
      {pending.length > 0 ? (
        <SettingsSection
          title={`Awaiting approval (${pending.length})`}
          headerAction={refreshAction}
        >
          {pending.map(renderRow)}
        </SettingsSection>
      ) : null}
      <SettingsSection title="Users" headerAction={pending.length > 0 ? undefined : refreshAction}>
        {others.map(renderRow)}
        {users !== null && others.length === 0 ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground/60">No approved users yet.</p>
          </div>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

const PortalUserRow = memo(function PortalUserRow({
  user,
  isCurrentUser,
  canManage,
  historyRevision,
  labelForUser,
  onChanged,
}: {
  readonly user: AuthUser;
  readonly isCurrentUser: boolean;
  readonly canManage: boolean;
  readonly historyRevision: number;
  readonly labelForUser: (userId: AuthUserId) => string | null;
  readonly onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [roleChoice, setRoleChoice] = useState<AuthUserRole>(user.role ?? "reader");
  const [showHistory, setShowHistory] = useState(false);
  const actions = portalUserActions(user);
  const label = portalUserLabel(user);

  /** Runs one access change; the action may return a note to show on the row. */
  const run = async (action: () => Promise<string | void>, confirmation?: string) => {
    if (
      confirmation &&
      (await requestConfirmDialog(confirmation, { variant: "destructive" })) !== true
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice((await action()) ?? null);
      await onChanged();
    } catch (cause) {
      setError(describeUserAdminError(cause));
    } finally {
      setBusy(false);
    }
  };
  const mutate = (mutation: Parameters<typeof mutatePortalUser>[0], confirmation?: string) =>
    run(async () => {
      await mutatePortalUser(mutation);
    }, confirmation);

  const details = [
    user.email && user.email !== label ? user.email : null,
    user.role ? PORTAL_USER_ROLE_LABELS[user.role] : null,
    user.lastSignInAt ? `Last sign-in ${formatTimestamp(user.lastSignInAt)}` : "Never signed in",
  ].filter((value): value is string => value !== null);

  const roleSelect = (value: AuthUserRole, onChange: (role: AuthUserRole) => void) => (
    <Select
      items={ROLE_ITEMS}
      value={value}
      disabled={busy}
      onValueChange={(role) => {
        if (role !== null) onChange(role);
      }}
    >
      <SelectTrigger size="xs" className="w-36" aria-label={`Role for ${label}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {ROLE_ITEMS.map(({ value: role, label: roleLabel }) => (
          <SelectItem key={role} value={role}>
            <span className="flex flex-col">
              <span>{roleLabel}</span>
              <span className="text-xs text-muted-foreground">
                {PORTAL_USER_ROLE_DESCRIPTIONS[role]}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="truncate text-sm font-medium text-foreground">{label}</h3>
            {isCurrentUser ? (
              <Badge size="sm" variant="outline">
                You
              </Badge>
            ) : null}
            {user.status !== "active" ? (
              <Badge size="sm" variant={user.status === "pending" ? "warning" : "error"}>
                {PORTAL_USER_STATUS_LABELS[user.status]}
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{details.join(" · ")}</p>
          {/* Email and name come from the user's own directory profile; the
              object ID is the stable identifier to check before approving. */}
          <p className="text-xs text-muted-foreground">
            Object ID <span className="font-mono select-all">{user.identity.objectId}</span>
          </p>
        </div>
        <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          {canManage && (actions.includes("approve") || actions.includes("enable-with-role")) ? (
            <>
              {roleSelect(roleChoice, setRoleChoice)}
              <Button
                size="xs"
                disabled={busy}
                onClick={() =>
                  void mutate(
                    actions.includes("approve")
                      ? { type: "approve", userId: user.userId, role: roleChoice }
                      : { type: "enable", userId: user.userId, role: roleChoice },
                  )
                }
              >
                {actions.includes("approve") ? "Approve" : "Enable"}
              </Button>
            </>
          ) : null}
          {canManage && actions.includes("change-role") && user.role
            ? roleSelect(user.role, (role) => {
                if (role === user.role) return;
                void mutate(
                  { type: "change-role", userId: user.userId, role },
                  isCurrentUser && role !== "administrator"
                    ? "Change your own role? You will lose access to this page."
                    : undefined,
                );
              })
            : null}
          {canManage && actions.includes("enable") ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void mutate({ type: "enable", userId: user.userId })}
            >
              Enable
            </Button>
          ) : null}
          {canManage && actions.includes("revoke-sessions") ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(
                  async () => {
                    const count = await revokePortalUserSessions(user.userId);
                    return `Ended ${count} ${count === 1 ? "session" : "sessions"}.`;
                  },
                  isCurrentUser
                    ? "Sign yourself out on every device, including this one?"
                    : `Sign ${label} out on every device?`,
                )
              }
            >
              Revoke sessions
            </Button>
          ) : null}
          {canManage && actions.includes("disable") ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() =>
                void mutate(
                  { type: "disable", userId: user.userId },
                  isCurrentUser
                    ? "Disable your own account? You will lose access immediately."
                    : `Disable ${label}? They lose access immediately.`,
                )
              }
            >
              Disable
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost-muted"
            aria-expanded={showHistory}
            onClick={() => setShowHistory((value) => !value)}
          >
            History
          </Button>
        </div>
      </div>
      {error ? <p className="mt-2 text-xs text-destructive-foreground">{error}</p> : null}
      {notice ? <p className="mt-2 text-xs text-muted-foreground">{notice}</p> : null}
      {showHistory ? (
        <UserAccessHistory key={historyRevision} userId={user.userId} labelForUser={labelForUser} />
      ) : null}
    </div>
  );
});

function UserAccessHistory({
  userId,
  labelForUser,
}: {
  readonly userId: AuthUserId;
  readonly labelForUser: (userId: AuthUserId) => string | null;
}) {
  const [changes, setChanges] = useState<ReadonlyArray<AuthUserAccessChange> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listPortalUserAccessChanges(userId).then(
      (result) => {
        if (!cancelled) setChanges(result);
      },
      (cause) => {
        if (!cancelled) setError(describeUserAdminError(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (error) return <p className="mt-3 text-xs text-destructive-foreground">{error}</p>;
  if (changes === null)
    return <p className="mt-3 text-xs text-muted-foreground">Loading history…</p>;
  if (changes.length === 0) {
    return <p className="mt-3 text-xs text-muted-foreground">No access changes recorded.</p>;
  }
  return (
    <ol className="mt-3 space-y-1 border-l border-border/70 pl-3">
      {changes.map((change) => (
        <li key={change.sequence} className="text-xs text-muted-foreground">
          <span className="text-foreground">{describeUserAccessChange(change)}</span>
          {" · "}
          {describeUserAccessActor(change.actor, labelForUser)}
          {" · "}
          {formatTimestamp(change.changedAt)}
        </li>
      ))}
    </ol>
  );
}
