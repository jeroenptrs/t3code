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
import { Link, Outlet, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ChartLineIcon, ChevronDownIcon, Settings2Icon } from "lucide-react";
import { createContext, use, useState } from "react";

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
  INSIGHTS_WINDOW_WEEKS,
  insightsChartByKey,
  insightsContributorLabel,
  insightsContributorsWithStatus,
  insightsWindowChoice,
  insightsWindowForWeeks,
  isInsightsDayRange,
} from "./insights.logic";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_WINDOW_WEEKS = 13;

const InsightsQuery = createContext<{
  readonly environmentId: EnvironmentId;
  readonly input: InsightsOverviewInput;
} | null>(null);

/** The overview for the window and filter in the URL; only rendered under `InsightsPage`. */
export function useInsightsOverview() {
  const query = use(InsightsQuery);
  if (query === null) throw new Error("useInsightsOverview needs InsightsPage around it.");
  return useEnvironmentQuery(insightsEnvironment.overview(query));
}

/**
 * The Insights layout: window, contributor filter and access checks around the overview and each
 * expanded chart. The window and filter live in the URL so both views and shared links agree.
 */
export function InsightsPage() {
  const environmentId = useInsightsEnvironmentId();
  const access = useInsightsAccess(environmentId);
  const search = useSearch({ from: "/insights" });
  const navigate = useNavigate();
  const chart = insightsChartByKey(useParams({ strict: false }).chart ?? "");
  // Fixed for the page's life, so the default window does not move under a mounted view.
  const [now] = useState(() => new Date());
  const [customOpen, setCustomOpen] = useState(false);
  const fallback = insightsWindowForWeeks(DEFAULT_WINDOW_WEEKS, now);
  const range = { from: search.from ?? fallback.from, to: search.to ?? fallback.to };
  const windowChoice = customOpen ? "custom" : insightsWindowChoice(range, now);
  // Null selects every included contributor, including people included later.
  const selected: ReadonlySet<InsightsContributorId> | null =
    search.contributors === undefined
      ? null
      : new Set(search.contributors as ReadonlyArray<InsightsContributorId>);
  const updateSearch = (patch: {
    readonly from?: string;
    readonly to?: string;
    readonly contributors?: ReadonlyArray<string> | undefined;
  }) =>
    void navigate({
      to: ".",
      search: (previous) => ({ ...previous, ...patch }),
      replace: true,
    });

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
          {chart === null ? (
            <h1>Insights</h1>
          ) : (
            <Link to="/insights" search={(previous) => previous}>
              Insights
            </Link>
          )}
        </WorkspaceBreadcrumbItem>
        {chart === null ? null : (
          <>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>
              <h1>{chart.title}</h1>
            </WorkspaceBreadcrumbItem>
          </>
        )}
        {access.canRead ? (
          <>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="min-w-10">
              <ContributorFilter
                contributors={included}
                selected={selected}
                onChange={(next) =>
                  updateSearch({
                    contributors: next === null ? undefined : [...next].toSorted(),
                  })
                }
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
                setCustomOpen(true);
                return;
              }
              const weeks = INSIGHTS_WINDOW_WEEKS.find((option) => String(option) === value);
              if (weeks === undefined) return;
              setCustomOpen(false);
              updateSearch(insightsWindowForWeeks(weeks, now));
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
                value={range.from}
                onChange={(event) => {
                  if (DAY_PATTERN.test(event.target.value)) {
                    updateSearch({ from: event.target.value });
                  }
                }}
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                type="date"
                size="sm"
                aria-label="To"
                value={range.to}
                onChange={(event) => {
                  if (DAY_PATTERN.test(event.target.value))
                    updateSearch({ to: event.target.value });
                }}
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
              <InsightsQuery value={{ environmentId, input }}>
                <Outlet />
              </InsightsQuery>
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
