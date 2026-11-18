/**
 * Fork-only. One factory: a header with its status, name, and tabs, and one view per tab. Each view
 * saves its own changes; nothing is held across tabs.
 */
import { FactoryId, parseFactoryId, type EnvironmentId, type Factory } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { msg, T, useGT, useMessages } from "gt-react";
import { FactoryIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { factoriesEnvironment, factoryErrorOf, useFactoryAccess } from "../../state/factories";
import { useEnvironmentQuery } from "../../state/query";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { NewWorkItemDialogHost } from "./NewWorkItemDialog";
import { FactoryOverviewTab } from "./FactoryOverviewTab";
import {
  FACTORY_ROUTE,
  FACTORY_TABS,
  factoryStatus,
  issueCountByTab,
  type FactoryPageSearch,
  type FactoryStatus,
  type FactoryTab,
} from "./FactoryPage.logic";
import {
  FactoryCardSkeleton,
  FactoryIssueCount,
  FactoryLoadError,
  FactoryStatusDot,
  type StatusTone,
} from "./FactoryPageParts";
import { FactoryRolePage } from "./FactoryRolePage";
import { FactoryRolesTab } from "./FactoryRolesTab";
import { FactorySettingsTab } from "./FactorySettingsTab";
import { FactorySkillsTab } from "./FactorySkillsTab";
import { FactoryTriggersTab } from "./FactoryTriggersTab";
import { FactoryWorkItemsTab } from "./FactoryWorkItemsTab";

const TAB_LABELS: Record<FactoryTab, string> = {
  overview: msg("Overview", { $context: "factory page tab" }),
  "work-items": msg("Work items", { $context: "factory page tab" }),
  roles: msg("Roles", { $context: "factory page tab" }),
  skills: msg("Skills", { $context: "factory page tab" }),
  triggers: msg("Triggers", { $context: "factory page tab" }),
  settings: msg("Settings", { $context: "factory page tab" }),
};

const STATUS: Record<FactoryStatus, { readonly tone: StatusTone; readonly label: string }> = {
  issues: { tone: "destructive", label: msg("The definition has problems") },
  attention: { tone: "warning", label: msg("Work waits on you") },
  ok: { tone: "success", label: msg("Nothing needs you") },
};

/** What a tab gets: the factory as last read or saved, and who may change it. */
export interface FactoryTabProps {
  readonly environmentId: EnvironmentId;
  readonly factory: Factory;
  readonly canManage: boolean;
  readonly search: FactoryPageSearch;
  /** A save's result, shown until the read that it triggers lands. */
  readonly onSaved: (factory: Factory) => void;
}

export function FactoryPage(props: {
  readonly environmentId: EnvironmentId;
  readonly factoryId: string;
  readonly search: FactoryPageSearch;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId, search } = props;
  const factoryId = FactoryId.make(props.factoryId);
  const navigate = useNavigate({ from: FACTORY_ROUTE });
  const access = useFactoryAccess(environmentId);
  const query = useEnvironmentQuery(
    access.canRead ? factoriesEnvironment.read({ environmentId, input: { factoryId } }) : null,
  );
  // The read refreshes after a save lands; until it does, show what the save returned.
  const [saved, setSaved] = useState<{ readonly from: Factory; readonly to: Factory } | null>(null);
  const read = query.data;
  const factory = read !== null && saved !== null && saved.from === read ? saved.to : read;
  const failure = factoryErrorOf(query.failure);
  const name = factory?.name ?? parseFactoryId(factoryId)?.name ?? props.factoryId;
  const tab: FactoryTab = search.tab ?? "overview";
  const issueCounts = factory === null ? null : issueCountByTab(factory.issues);
  const status = factory === null ? null : STATUS[factoryStatus(factory)];
  const notFound = failure?.code === "not_found" || failure?.code === "project_not_found";
  const retry = () => factoriesEnvironment.refresh(appAtomRegistry, environmentId);

  const tabProps =
    factory === null
      ? null
      : ({
          environmentId,
          factory,
          canManage: access.canManage,
          search,
          onSaved: (next: Factory) => {
            if (read !== null) setSaved({ from: read, to: next });
          },
        } satisfies FactoryTabProps);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex min-w-0 shrink items-center gap-2">
            {status === null ? (
              <Skeleton shape="pill" className="size-2 shrink-0" />
            ) : (
              <FactoryStatusDot tone={status.tone} label={messages(status.label)} />
            )}
            <h1 className="truncate text-sm font-medium">{name}</h1>
          </div>
          {access.canRead && !notFound ? (
            <nav
              aria-label={gt("Factory tabs")}
              className="ms-2 flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]"
            >
              <ToggleGroup
                className="shrink-0"
                variant="segmented"
                value={[tab]}
                onValueChange={(next) => {
                  const picked = FACTORY_TABS.find((candidate) => candidate === next[0]);
                  if (picked === undefined || picked === tab) return;
                  void navigate({ search: picked === "overview" ? {} : { tab: picked } });
                }}
              >
                {FACTORY_TABS.map((value) => (
                  <Toggle key={value} value={value}>
                    {messages(TAB_LABELS[value])}
                    <FactoryIssueCount count={issueCounts?.get(value) ?? 0} />
                  </Toggle>
                ))}
              </ToggleGroup>
            </nav>
          ) : null}
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {!access.loaded ? (
              <FactoryCardSkeleton />
            ) : !access.canRead ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>
                    <T>No access to factories</T>
                  </EmptyTitle>
                  <EmptyDescription>
                    <T>Factories need an operator or administrator role on this environment.</T>
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : notFound ? (
              <Empty>
                <EmptyMedia variant="icon">
                  <FactoryIcon />
                </EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>
                    <T>Factory not found</T>
                  </EmptyTitle>
                  <EmptyDescription>
                    <T>
                      Its folder under .t3/factories was renamed or removed, or its project is gone.
                    </T>
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : tabProps === null ? (
              query.error === null ? (
                <FactoryCardSkeleton rows={tab === "overview" ? 2 : 4} />
              ) : (
                <FactoryLoadError
                  title={gt("Could not load the factory")}
                  message={query.error}
                  onRetry={retry}
                />
              )
            ) : tab === "overview" ? (
              <FactoryOverviewTab {...tabProps} />
            ) : tab === "work-items" ? (
              <FactoryWorkItemsTab {...tabProps} />
            ) : tab === "roles" ? (
              search.role === undefined ? (
                <FactoryRolesTab {...tabProps} />
              ) : (
                <FactoryRolePage key={search.role} {...tabProps} role={search.role} />
              )
            ) : tab === "skills" ? (
              <FactorySkillsTab {...tabProps} />
            ) : tab === "triggers" ? (
              <FactoryTriggersTab {...tabProps} />
            ) : (
              <FactorySettingsTab {...tabProps} />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
        <NewWorkItemDialogHost environmentId={environmentId} factoryId={factoryId} />
      </div>
    </SidebarInset>
  );
}
