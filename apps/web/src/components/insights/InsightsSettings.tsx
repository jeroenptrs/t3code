/**
 * Fork-only. Settings → Insights: the start date, the GitLab projects ingestion covers, and the
 * people whose work it stores. Projects and people both start off; an administrator turns each on.
 */
import type {
  EnvironmentId,
  InsightsConfig,
  InsightsContributor,
  InsightsContributorKind,
  InsightsContributorStatus,
  InsightsProject,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  insightsEnvironment,
  useInsightsAccess,
  useInsightsEnvironmentId,
} from "../../state/insights";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "../settings/itemRows";
import { SettingsPageContainer, SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  insightsContributorLabel,
  insightsContributorsWithStatus,
  isInsightsAuthenticationError,
  parseInsightsBranchPatterns,
} from "./insights.logic";

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : timestampFormatter.format(date);
}

const STATUS_TABS: ReadonlyArray<{ value: InsightsContributorStatus; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "included", label: "Included" },
  { value: "excluded", label: "Excluded" },
];

const KIND_ITEMS: ReadonlyArray<{ value: InsightsContributorKind; label: string }> = [
  { value: "human", label: "Person" },
  { value: "agent", label: "Agent" },
  { value: "bot", label: "Bot" },
];

export function InsightsSettings() {
  const environmentId = useInsightsEnvironmentId();
  const access = useInsightsAccess(environmentId);
  if (!access.loaded) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">Loading your access…</p>
      </SettingsPageContainer>
    );
  }
  if (!access.canRead || environmentId === null) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          Insights needs an administrator role on this environment.
        </p>
      </SettingsPageContainer>
    );
  }
  return <InsightsSettingsPanel environmentId={environmentId} />;
}

export function InsightsSettingsPanel({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const config = useEnvironmentQuery(insightsEnvironment.config({ environmentId, input: {} }));
  const canManage = useAtomValue(
    insightsEnvironment.setProjectEnabled.permissionAtom(environmentId),
  );

  if (config.data === null) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          {config.error ?? "Reading Insights settings…"}
        </p>
      </SettingsPageContainer>
    );
  }
  const refreshAction = (
    <Button
      size="icon-xs"
      variant="ghost-muted"
      aria-label="Refresh Insights settings"
      onClick={() => insightsEnvironment.refresh(appAtomRegistry, environmentId)}
    >
      <RefreshIcon refreshing={config.isPending} />
    </Button>
  );

  return (
    <SettingsPageContainer width="wide">
      <p className="px-3 text-xs text-muted-foreground sm:px-4">
        Insights estimates coding output per contributor from GitLab merge requests and the commits
        in each enabled project's checkout. Only administrators see it.{" "}
        <Link to="/insights" className="underline">
          Open Insights
        </Link>
      </p>
      <IngestionSection
        key={config.data.settings.updatedAt ?? "default"}
        environmentId={environmentId}
        settings={config.data.settings}
        canManage={canManage}
      />
      <SettingsSection title="Projects" headerAction={refreshAction}>
        {config.data.projects.length === 0 ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              No project on this server has a GitLab remote. Add the repository as a project first.
            </p>
          </div>
        ) : (
          config.data.projects.map((project) => (
            <ProjectRow
              key={project.projectId}
              environmentId={environmentId}
              project={project}
              canManage={canManage}
            />
          ))
        )}
      </SettingsSection>
      <ContributorsSection
        environmentId={environmentId}
        contributors={config.data.contributors}
        canManage={canManage}
      />
    </SettingsPageContainer>
  );
}

function IngestionSection({
  environmentId,
  settings,
  canManage,
}: {
  readonly environmentId: EnvironmentId;
  readonly settings: InsightsConfig["settings"];
  readonly canManage: boolean;
}) {
  const updateSettings = useAtomCommand(
    insightsEnvironment.updateSettings,
    "save Insights settings",
  );
  const [startDate, setStartDate] = useState(settings.startDate);
  const [patterns, setPatterns] = useState(settings.releaseBranchPatterns.join(", "));
  const [budget, setBudget] = useState(String(settings.requestBudgetPerTick));
  const [saving, setSaving] = useState(false);
  const budgetValue = Number(budget);
  const validBudget = Number.isInteger(budgetValue) && budgetValue >= 1 && budgetValue <= 200;
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(startDate);
  const parsedPatterns = parseInsightsBranchPatterns(patterns);
  const dirty =
    startDate !== settings.startDate ||
    parsedPatterns.join("\n") !== settings.releaseBranchPatterns.join("\n") ||
    budgetValue !== settings.requestBudgetPerTick;

  const save = async () => {
    setSaving(true);
    await updateSettings({
      environmentId,
      input: {
        startDate,
        releaseBranchPatterns: [...parsedPatterns],
        requestBudgetPerTick: budgetValue,
      },
    });
    setSaving(false);
  };

  return (
    <SettingsSection title="Ingestion">
      <div className={ITEM_ROW_CLASSNAME}>
        <div className={ITEM_ROW_INNER_CLASSNAME}>
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="text-sm font-medium">Start date</h3>
            <p className="text-xs text-muted-foreground">
              Nothing before this day is read from GitLab or fetched. Moving it earlier reads the
              gap; moving it later keeps what is already stored.
            </p>
          </div>
          <div className="w-full shrink-0 sm:w-44">
            <Input
              type="date"
              size="sm"
              aria-label="Start date"
              disabled={!canManage}
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </div>
        </div>
      </div>
      <div className={ITEM_ROW_CLASSNAME}>
        <div className={ITEM_ROW_INNER_CLASSNAME}>
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="text-sm font-medium">Release branches</h3>
            <p className="text-xs text-muted-foreground">
              Commits reaching these branches count as landed, besides the default branch. Comma
              separated globs, such as <code>release/*</code>.
            </p>
          </div>
          <div className="w-full shrink-0 sm:w-64">
            <Input
              size="sm"
              aria-label="Release branches"
              disabled={!canManage}
              value={patterns}
              placeholder="release/*"
              onChange={(event) => setPatterns(event.target.value)}
            />
          </div>
        </div>
      </div>
      <div className={ITEM_ROW_CLASSNAME}>
        <div className={ITEM_ROW_INNER_CLASSNAME}>
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="text-sm font-medium">Requests per tick</h3>
            <p className="text-xs text-muted-foreground">
              GitLab requests ingestion may make per host every five seconds, from 1 to 200. A rate
              limit from GitLab pauses that host for the pull request panel too.
            </p>
          </div>
          <div className="w-full shrink-0 sm:w-28">
            <Input
              type="number"
              size="sm"
              min={1}
              max={200}
              aria-label="Requests per tick"
              disabled={!canManage}
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
            />
          </div>
        </div>
      </div>
      {canManage ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <div className="flex justify-end">
            <Button
              size="xs"
              disabled={!dirty || !validBudget || !validDate || saving}
              onClick={() => void save()}
            >
              Save
            </Button>
          </div>
        </div>
      ) : null}
    </SettingsSection>
  );
}

function ProjectRow({
  environmentId,
  project,
  canManage,
}: {
  readonly environmentId: EnvironmentId;
  readonly project: InsightsProject;
  readonly canManage: boolean;
}) {
  const setEnabled = useAtomCommand(
    insightsEnvironment.setProjectEnabled,
    "change an Insights project",
  );
  const rescan = useAtomCommand(insightsEnvironment.rescanProject, "rescan an Insights project");
  const [busy, setBusy] = useState(false);

  const toggle = async (enabled: boolean) => {
    if (
      !enabled &&
      (await requestConfirmDialog(
        `Stop reading ${project.title}? Its stored commits, merge requests and reviews are deleted.`,
        { variant: "destructive" },
      )) !== true
    ) {
      return;
    }
    setBusy(true);
    await setEnabled({ environmentId, input: { projectId: project.projectId, enabled } });
    setBusy(false);
  };
  const runRescan = async () => {
    setBusy(true);
    await rescan({ environmentId, input: { projectId: project.projectId } });
    setBusy(false);
  };

  const status = !project.enabled
    ? "Off"
    : project.syncedThrough === null
      ? "First sync in progress"
      : `Synced through ${formatTimestamp(project.syncedThrough)}`;

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="truncate text-sm font-medium">{project.title}</h3>
          <p className="text-xs text-muted-foreground">
            {[
              `${project.host}/${project.repository}`,
              status,
              project.lastSyncAt ? `Last run ${formatTimestamp(project.lastSyncAt)}` : null,
            ]
              .filter((value) => value !== null)
              .join(" · ")}
          </p>
          {project.lastError ? (
            <p className="text-xs text-destructive-foreground">
              {project.lastError}
              {isInsightsAuthenticationError(project.lastError) ? (
                <>
                  {" "}
                  Sign in on the server with <code>glab auth login</code>.
                </>
              ) : null}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {project.enabled && canManage ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void runRescan()}>
              Rescan
            </Button>
          ) : null}
          <Switch
            aria-label={`Read ${project.title}`}
            checked={project.enabled}
            disabled={!canManage || busy}
            onCheckedChange={(checked) => void toggle(checked)}
          />
        </div>
      </div>
    </div>
  );
}

function ContributorsSection({
  environmentId,
  contributors,
  canManage,
}: {
  readonly environmentId: EnvironmentId;
  readonly contributors: ReadonlyArray<InsightsContributor>;
  readonly canManage: boolean;
}) {
  const [tab, setTab] = useState<InsightsContributorStatus>("pending");
  const shown = insightsContributorsWithStatus(contributors, tab);
  const counts = new Map(
    STATUS_TABS.map(({ value }) => [
      value,
      contributors.filter((contributor) => contributor.status === value).length,
    ]),
  );

  return (
    <SettingsSection
      title="Contributors"
      headerAction={
        <ToggleGroup
          aria-label="Contributor status"
          variant="segmented"
          value={[tab]}
          onValueChange={(next) => {
            const value = STATUS_TABS.find((option) => option.value === next[0]);
            if (value !== undefined) setTab(value.value);
          }}
        >
          {STATUS_TABS.map((option) => (
            <Toggle key={option.value} value={option.value}>
              {option.label} ({counts.get(option.value) ?? 0})
            </Toggle>
          ))}
        </ToggleGroup>
      }
    >
      {shown.length === 0 ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-xs text-muted-foreground">
            {tab === "pending"
              ? "No one is waiting. New commit authors and merge request authors appear here."
              : tab === "included"
                ? "No one is included yet."
                : "No one is excluded."}
          </p>
        </div>
      ) : (
        shown.map((contributor) => (
          <ContributorRow
            key={contributor.contributorId}
            environmentId={environmentId}
            contributor={contributor}
            others={contributors.filter(
              (candidate) => candidate.contributorId !== contributor.contributorId,
            )}
            canManage={canManage}
          />
        ))
      )}
    </SettingsSection>
  );
}

function ContributorRow({
  environmentId,
  contributor,
  others,
  canManage,
}: {
  readonly environmentId: EnvironmentId;
  readonly contributor: InsightsContributor;
  readonly others: ReadonlyArray<InsightsContributor>;
  readonly canManage: boolean;
}) {
  const update = useAtomCommand(
    insightsEnvironment.updateContributor,
    "change an Insights contributor",
  );
  const merge = useAtomCommand(
    insightsEnvironment.mergeContributors,
    "merge Insights contributors",
  );
  const [busy, setBusy] = useState(false);
  const label = insightsContributorLabel(contributor);

  const run = async (action: () => Promise<unknown>, confirmation?: string) => {
    if (
      confirmation !== undefined &&
      (await requestConfirmDialog(confirmation, { variant: "destructive" })) !== true
    ) {
      return;
    }
    setBusy(true);
    await action();
    setBusy(false);
  };
  const setStatus = (status: "included" | "excluded") =>
    run(
      () => update({ environmentId, input: { contributorId: contributor.contributorId, status } }),
      status === "excluded" && contributor.status === "included"
        ? `Exclude ${label}? Their stored commits, merge requests and reviews are deleted.`
        : undefined,
    );

  const details = [
    contributor.gitlabLogin ? `@${contributor.gitlabLogin}` : null,
    ...contributor.emails,
    contributor.userId !== null ? "Portal user" : null,
  ].filter((value) => value !== null);

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="truncate text-sm font-medium">{label}</h3>
          <p className="truncate text-xs text-muted-foreground">{details.join(" · ")}</p>
        </div>
        {canManage ? (
          <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            <Select
              items={KIND_ITEMS}
              value={contributor.kind}
              disabled={busy}
              onValueChange={(kind) => {
                if (kind !== null && kind !== contributor.kind) {
                  void run(() =>
                    update({
                      environmentId,
                      input: { contributorId: contributor.contributorId, kind },
                    }),
                  );
                }
              }}
            >
              <SelectTrigger size="xs" className="w-24" aria-label={`Kind of ${label}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {KIND_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {others.length > 0 ? (
              <Menu>
                <MenuTrigger render={<Button size="xs" variant="outline" disabled={busy} />}>
                  Merge into…
                </MenuTrigger>
                <MenuPopup align="end">
                  {others.map((target) => (
                    <MenuItem
                      key={target.contributorId}
                      onClick={() =>
                        void run(
                          () =>
                            merge({
                              environmentId,
                              input: {
                                sourceContributorId: contributor.contributorId,
                                targetContributorId: target.contributorId,
                              },
                            }),
                          `Merge ${label} into ${insightsContributorLabel(target)}? Their emails and stored work move to ${insightsContributorLabel(target)}.`,
                        )
                      }
                    >
                      {insightsContributorLabel(target)}
                      {target.status === "included" ? null : (
                        <Badge size="sm" variant="outline">
                          {target.status === "pending" ? "Pending" : "Excluded"}
                        </Badge>
                      )}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            ) : null}
            {contributor.status !== "included" ? (
              <Button size="xs" disabled={busy} onClick={() => void setStatus("included")}>
                Include
              </Button>
            ) : null}
            {contributor.status !== "excluded" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void setStatus("excluded")}
              >
                Exclude
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
