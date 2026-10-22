/**
 * Fork-only. Estimated coding output per contributor from the GitLab projects an administrator
 * enabled under Settings → Insights. Every number is a model estimate of coding output; the page
 * says so next to each view and asks readers to treat it as a team trend.
 */
import type {
  EnvironmentId,
  InsightsContributor,
  InsightsContributorId,
  InsightsOverviewInput,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChartLineIcon, ChevronDownIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  insightsEnvironment,
  useInsightsAccess,
  useInsightsEnvironmentId,
} from "../../state/insights";
import { useEnvironmentQuery } from "../../state/query";
import { Button, InlineButton } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  INSIGHTS_ESTIMATE_LABEL,
  INSIGHTS_WINDOW_WEEKS,
  insightsContributorLabel,
  insightsContributorsWithStatus,
  insightsWindowForWeeks,
  isInsightsDayRange,
} from "./insights.logic";
import { InsightsContributorTable } from "./InsightsContributorTable";
import { InsightsTrendChart } from "./InsightsTrendChart";

type WindowChoice = (typeof INSIGHTS_WINDOW_WEEKS)[number] | "custom";

export function InsightsPage() {
  const environmentId = useInsightsEnvironmentId();
  const access = useInsightsAccess(environmentId);
  const [windowChoice, setWindowChoice] = useState<WindowChoice>(13);
  // Fixed for the page's life, so the query key does not move under a mounted view.
  const [now] = useState(() => new Date());
  const preset = insightsWindowForWeeks(windowChoice === "custom" ? 13 : windowChoice, now);
  const [custom, setCustom] = useState(preset);
  const range = windowChoice === "custom" ? custom : preset;
  // Null selects every included contributor, including people included later.
  const [selected, setSelected] = useState<ReadonlySet<InsightsContributorId> | null>(null);

  const canQuery = environmentId !== null && access.canRead;
  const config = useEnvironmentQuery(
    canQuery ? insightsEnvironment.config({ environmentId, input: {} }) : null,
  );
  const included = insightsContributorsWithStatus(config.data?.contributors ?? [], "included");
  const validRange = isInsightsDayRange(range.from, range.to);
  const input: InsightsOverviewInput = {
    from: range.from,
    to: range.to,
    ...(selected === null ? {} : { contributorIds: [...selected].toSorted() }),
  };

  const topbar = (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-2">
      <WorkspaceBreadcrumb ariaLabel="Insights breadcrumb" className="min-w-0">
        <WorkspaceBreadcrumbItem>
          <h1>Insights</h1>
        </WorkspaceBreadcrumbItem>
        {access.canRead ? (
          <>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="min-w-10">
              <ContributorFilter
                contributors={included}
                selected={selected}
                onChange={setSelected}
              />
            </WorkspaceBreadcrumbItem>
          </>
        ) : null}
      </WorkspaceBreadcrumb>
      {access.canRead && environmentId !== null ? (
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <ToggleGroup
            aria-label="Insights window"
            variant="segmented"
            value={[String(windowChoice)]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "custom") {
                setCustom(range);
                setWindowChoice("custom");
                return;
              }
              const weeks = INSIGHTS_WINDOW_WEEKS.find((option) => String(option) === value);
              if (weeks !== undefined) setWindowChoice(weeks);
            }}
          >
            {INSIGHTS_WINDOW_WEEKS.map((weeks) => (
              <Toggle key={weeks} value={String(weeks)}>
                {weeks}w
              </Toggle>
            ))}
            <Toggle value="custom">Custom</Toggle>
          </ToggleGroup>
          {windowChoice === "custom" ? (
            <div className="flex items-center gap-1.5">
              <Input
                type="date"
                size="sm"
                aria-label="From"
                value={custom.from}
                onChange={(event) => setCustom({ ...custom, from: event.target.value })}
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                type="date"
                size="sm"
                aria-label="To"
                value={custom.to}
                onChange={(event) => setCustom({ ...custom, to: event.target.value })}
              />
            </div>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Refresh insights"
            onClick={() => insightsEnvironment.refresh(appAtomRegistry, environmentId)}
          >
            <RefreshIcon refreshing={config.isPending} />
          </Button>
          {access.canManage ? (
            <Button size="xs" variant="outline" render={<Link to="/settings/insights" />}>
              <Settings2Icon />
              Configure
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>{topbar}</WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded">
            {!access.loaded ? (
              <p className="text-sm text-muted-foreground">Loading your access…</p>
            ) : !access.canRead || environmentId === null ? (
              <p className="text-sm text-muted-foreground">
                Insights needs an administrator role on this environment.
              </p>
            ) : config.data !== null && !config.data.projects.some((project) => project.enabled) ? (
              <NothingEnabled canManage={access.canManage} />
            ) : !validRange ? (
              <p className="text-sm text-muted-foreground">
                Pick a start day on or before the end day.
              </p>
            ) : (
              <InsightsOverview environmentId={environmentId} input={input} />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function NothingEnabled({ canManage }: { readonly canManage: boolean }) {
  return (
    <Empty>
      <EmptyMedia variant="icon">
        <ChartLineIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>No projects enabled yet</EmptyTitle>
        <EmptyDescription>
          Insights reads the GitLab projects an administrator enables under Settings → Insights,
          from the start date onward.
        </EmptyDescription>
      </EmptyHeader>
      {canManage ? (
        <Button size="sm" render={<Link to="/settings/insights" />}>
          Open Insights settings
        </Button>
      ) : null}
    </Empty>
  );
}

function InsightsOverview({
  environmentId,
  input,
}: {
  readonly environmentId: EnvironmentId;
  readonly input: InsightsOverviewInput;
}) {
  const overview = useEnvironmentQuery(insightsEnvironment.overview({ environmentId, input }));
  if (overview.data === null) {
    return (
      <p className="text-sm text-muted-foreground">
        {overview.error ?? "Reading estimated coding output…"}
      </p>
    );
  }
  const { weeks, contributors, workingDays } = overview.data;
  return (
    <>
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Team trend</h2>
          <p className="text-xs text-muted-foreground">{INSIGHTS_ESTIMATE_LABEL}</p>
        </div>
        <InsightsTrendChart weeks={weeks} />
      </section>
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Contributors</h2>
          <p className="text-xs text-muted-foreground">
            {INSIGHTS_ESTIMATE_LABEL} Throughput is pushed hours over {workingDays} working{" "}
            {workingDays === 1 ? "day" : "days"} of eight hours.
          </p>
        </div>
        {contributors.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No included contributor has commits or merge requests in this window.
          </p>
        ) : (
          <InsightsContributorTable rows={contributors} />
        )}
        <p className="text-xs text-muted-foreground">
          Read these numbers as a team trend. Do not rank or judge individuals by them: estimates
          per person are noisy, leave out review, planning and investigation, and reward large
          diffs.
        </p>
      </section>
    </>
  );
}

function ContributorFilter({
  contributors,
  selected,
  onChange,
}: {
  readonly contributors: ReadonlyArray<InsightsContributor>;
  readonly selected: ReadonlySet<InsightsContributorId> | null;
  readonly onChange: (next: ReadonlySet<InsightsContributorId> | null) => void;
}) {
  const only =
    selected?.size === 1
      ? contributors.find((contributor) => selected.has(contributor.contributorId))
      : undefined;
  const label =
    selected === null
      ? "All included contributors"
      : only !== undefined
        ? insightsContributorLabel(only)
        : `${selected.size} ${selected.size === 1 ? "contributor" : "contributors"}`;
  return (
    <Menu>
      <MenuTrigger render={<InlineButton tone="picker" />}>
        <span className="truncate">{label}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuCheckboxItem
          checked={selected === null}
          closeOnClick={false}
          onCheckedChange={(checked) => onChange(checked ? null : new Set())}
        >
          All included contributors
        </MenuCheckboxItem>
        <MenuSeparator />
        {contributors.map((contributor) => (
          <MenuCheckboxItem
            key={contributor.contributorId}
            checked={selected === null || selected.has(contributor.contributorId)}
            closeOnClick={false}
            onCheckedChange={(checked) => {
              const next = new Set(
                selected ?? contributors.map((candidate) => candidate.contributorId),
              );
              if (checked) next.add(contributor.contributorId);
              else next.delete(contributor.contributorId);
              onChange(next.size === contributors.length ? null : next);
            }}
          >
            {insightsContributorLabel(contributor)}
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
