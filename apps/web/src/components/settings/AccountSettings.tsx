import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, JiraCapabilities, JiraPersonalCredential } from "@t3tools/contracts";
import { ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { jiraEnvironment, useJiraCapabilities, useJiraEnvironmentId } from "../../state/jira";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestActorAvatar } from "../pullRequest/pullRequestPresentation";
import { Alert, AlertDescription } from "../ui/alert";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ITEM_ROW_CLASSNAME } from "./itemRows";
import { SecretInput } from "./SecretInput";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useCanOpenAccountSettings } from "./useCanOpenAccountSettings";

const ATLASSIAN_TOKENS_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : timestampFormatter.format(date);
}

function failureMessage(failure: unknown, fallback: string): string {
  return failure instanceof Error && failure.message.trim().length > 0 ? failure.message : fallback;
}

/** The signed-in user's own settings. For now that is the Jira token. */
export function AccountSettings() {
  const environmentId = useJiraEnvironmentId();
  const capabilities = useJiraCapabilities(environmentId);
  const available = useCanOpenAccountSettings();

  if (capabilities === null) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">Loading your account…</p>
      </SettingsPageContainer>
    );
  }
  if (!available || environmentId === null) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          Account settings need a sign-in through your organization on a server with Jira set up.
        </p>
      </SettingsPageContainer>
    );
  }
  return (
    <SettingsPageContainer>
      <JiraTokenSection environmentId={environmentId} capabilities={capabilities} />
    </SettingsPageContainer>
  );
}

function JiraTokenSection({
  environmentId,
  capabilities,
}: {
  readonly environmentId: EnvironmentId;
  readonly capabilities: JiraCapabilities;
}) {
  const credential = capabilities.personalCredential;
  const [replacing, setReplacing] = useState(false);
  return (
    <SettingsSection title="Jira" id="account-jira">
      {credential === null ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <JiraTokenIntro />
          <JiraTokenForm environmentId={environmentId} capabilities={capabilities} />
        </div>
      ) : (
        <>
          <StoredCredential
            environmentId={environmentId}
            credential={credential}
            replacing={replacing}
            onToggleReplace={() => setReplacing((value) => !value)}
          />
          {replacing ? (
            <div className={ITEM_ROW_CLASSNAME}>
              <JiraTokenForm
                environmentId={environmentId}
                capabilities={capabilities}
                onSaved={() => setReplacing(false)}
              />
            </div>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}

function JiraTokenIntro() {
  return (
    <div className="mb-3 grid max-w-2xl gap-2 text-xs leading-relaxed text-muted-foreground">
      <p>
        Add your own Jira API token and the Issues page and issue panel read Jira as you, not as the
        server's shared account. Jira changes you approve in threads are made with it later. Agents
        never get the token.
      </p>
      <p>
        <InlineButton
          render={<a href={ATLASSIAN_TOKENS_URL} target="_blank" rel="noreferrer noopener" />}
        >
          Create a token
          <ExternalLinkIcon aria-hidden className="size-3" />
        </InlineButton>{" "}
        in your Atlassian account. For a scoped token, give it{" "}
        <code className="rounded bg-muted px-1 py-px text-2xs">read:jira-work</code>,{" "}
        <code className="rounded bg-muted px-1 py-px text-2xs">read:jira-user</code> and{" "}
        <code className="rounded bg-muted px-1 py-px text-2xs">write:jira-work</code>.
      </p>
    </div>
  );
}

function StoredCredential({
  environmentId,
  credential,
  replacing,
  onToggleReplace,
}: {
  readonly environmentId: EnvironmentId;
  readonly credential: JiraPersonalCredential;
  readonly replacing: boolean;
  readonly onToggleReplace: () => void;
}) {
  const testToken = useAtomCommand(jiraEnvironment.testPersonalToken, {
    label: "test Jira token",
    reportFailure: false,
  });
  const clearToken = useAtomCommand(jiraEnvironment.clearPersonalToken, {
    label: "remove Jira token",
    reportFailure: false,
  });
  const [busy, setBusy] = useState<"test" | "remove" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async (kind: "test" | "remove") => {
    if (
      kind === "remove" &&
      (await requestConfirmDialog(
        "Remove your Jira token? Jira reads go back to the server's shared account.",
        { variant: "destructive" },
      )) !== true
    ) {
      return;
    }
    setBusy(kind);
    setFailure(null);
    try {
      const outcome =
        kind === "test"
          ? await testToken({ environmentId, input: {} })
          : await clearToken({ environmentId, input: {} });
      if (outcome._tag === "Failure") {
        setFailure(
          failureMessage(
            squashAtomCommandFailure(outcome),
            kind === "test" ? "The token could not be tested." : "The token could not be removed.",
          ),
        );
      }
    } finally {
      setBusy(null);
    }
  };

  const account = credential.account;
  const details = [
    credential.site,
    credential.lastVerifiedAt
      ? `Verified ${formatTimestamp(credential.lastVerifiedAt)}`
      : "Not verified yet",
  ];
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2.5">
          <PullRequestActorAvatar
            actor={
              account === null
                ? null
                : {
                    login: account.displayName || "?",
                    name: account.displayName,
                    avatarUrl: account.avatarUrl,
                  }
            }
            className="size-6"
          />
          <div className="min-w-0">
            <p className="truncate text-sm text-foreground">
              {account?.displayName || "Jira token stored"}
            </p>
            <p className="truncate text-xs text-muted-foreground">{details.join(" · ")}</p>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void run("test")}
          >
            {busy === "test" ? "Testing…" : "Test"}
          </Button>
          <Button size="xs" variant="outline" disabled={busy !== null} onClick={onToggleReplace}>
            {replacing ? "Cancel" : "Replace"}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void run("remove")}
          >
            Remove
          </Button>
        </div>
      </div>
      {credential.error !== null || failure !== null ? (
        <Alert variant="error" className="mt-3">
          <TriangleAlertIcon aria-hidden />
          <AlertDescription>{failure ?? credential.error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function JiraTokenForm({
  environmentId,
  capabilities,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly capabilities: JiraCapabilities;
  readonly onSaved?: () => void;
}) {
  const setToken = useAtomCommand(jiraEnvironment.setPersonalToken, {
    label: "save Jira token",
    reportFailure: false,
  });
  const sites = useMemo(
    () => [...new Set(capabilities.identities.map((identity) => identity.site))],
    [capabilities.identities],
  );
  const defaultSite = capabilities.reader?.site ?? sites[0] ?? null;
  const [site, setSite] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [token, setTokenDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const chosenSite = site ?? defaultSite;
  const siteItems = sites.map((value) => ({ value, label: value }));
  const canSave = email.trim().length > 0 && token.trim().length > 0 && !saving;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setFailure(null);
    try {
      const outcome = await setToken({
        environmentId,
        input: {
          ...(sites.length > 1 && chosenSite !== null ? { site: chosenSite } : {}),
          email: email.trim(),
          token: token.trim(),
        },
      });
      if (outcome._tag === "Success") {
        setEmail("");
        setTokenDraft("");
        onSaved?.();
      } else {
        setFailure(
          failureMessage(squashAtomCommandFailure(outcome), "The token could not be saved."),
        );
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="grid gap-3" onSubmit={(event) => void save(event)}>
      {/* Locked while saving: a successful save clears the draft, which would drop edits made mid-request. */}
      <fieldset disabled={saving} className="contents">
        {sites.length > 1 ? (
          <div className="grid gap-1.5 sm:max-w-sm">
            <Label htmlFor="account-jira-site">Site</Label>
            <Select
              items={siteItems}
              value={chosenSite}
              onValueChange={(value) => {
                if (value !== null) setSite(value);
              }}
            >
              <SelectTrigger id="account-jira-site" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {siteItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="account-jira-email">Atlassian email</Label>
            <Input
              id="account-jira-email"
              type="email"
              size="sm"
              autoComplete="off"
              spellCheck={false}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="account-jira-token">API token</Label>
            <SecretInput
              id="account-jira-token"
              size="sm"
              value={token}
              onChange={(event) => setTokenDraft(event.target.value)}
            />
          </div>
        </div>
        {failure !== null ? <p className="text-xs text-destructive-foreground">{failure}</p> : null}
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Jira checks the token before it is stored.
          </p>
          <Button type="submit" size="xs" disabled={!canSave}>
            {saving ? "Checking…" : "Save"}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
