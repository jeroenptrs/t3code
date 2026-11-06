/**
 * Fork-only. One factory: its definition, its three roles, and what of its work needs a person.
 * Operators read it; administrators edit the definition and role files and save them in one go,
 * and manage the skills its roles bind one at a time.
 */
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  FactoryId,
  parseFactoryId,
  type ThreadId,
  type EnvironmentId,
  type Factory,
  type FactoryIssue,
  type FactoryRoleName,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { FactoryIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProjects } from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
import { factoriesEnvironment, factoryErrorOf, useFactoryAccess } from "../../state/factories";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { FactoryAttentionBadge } from "./FactoryAttentionBadge";
import { FactoryCanvas } from "./FactoryCanvas";
import { FactoryDefinitionSection } from "./FactoryDefinitionSection";
import { FactoryIssuesList } from "./FactoryIssues";
import {
  buildFactorySaveInput,
  factoryDraft,
  factoryDraftChanged,
  type FactoryDraft,
  type FactoryRoleDraft,
} from "./FactoryPage.logic";
import { FactoryRoleCard, type FactoryModelChoices } from "./FactoryRoleCard";
import { FactorySkillsSection } from "./FactorySkillsSection";
import { FactoryNeedsYou, FactoryWorkItems } from "./FactoryWorkItems";
import type { WorkItemSearch } from "./workItems.logic";

export function FactoryPage(props: {
  readonly environmentId: EnvironmentId;
  readonly factoryId: string;
  readonly workItemSearch: WorkItemSearch;
  readonly onWorkItemSearchChange: (search: WorkItemSearch) => void;
}) {
  const { environmentId } = props;
  const factoryId = FactoryId.make(props.factoryId);
  const access = useFactoryAccess(environmentId);
  const query = useEnvironmentQuery(
    access.canRead ? factoriesEnvironment.read({ environmentId, input: { factoryId } }) : null,
  );
  const failure = factoryErrorOf(query.failure);
  const name = query.data?.name ?? parseFactoryId(factoryId)?.name ?? "Factory";
  const foremanThreadId =
    query.data?.threads.find((thread) => thread.role === "foreman")?.threadId ?? null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Factory breadcrumb" className="min-w-0 flex-1">
            <WorkspaceBreadcrumbItem>Factories</WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">{name}</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          {foremanThreadId === null ? null : (
            <ForemanLink environmentId={environmentId} threadId={foremanThreadId} />
          )}
          {access.canRead ? (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Refresh factory"
              onClick={() => factoriesEnvironment.refresh(appAtomRegistry, environmentId)}
            >
              <RefreshIcon refreshing={query.isPending} />
            </Button>
          ) : null}
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {!access.loaded ? (
              <p className="text-sm text-muted-foreground">Loading your access…</p>
            ) : !access.canRead ? (
              <p className="text-sm text-muted-foreground">
                Factories need an operator or administrator role on this environment.
              </p>
            ) : failure?.code === "not_found" || failure?.code === "project_not_found" ? (
              <Empty>
                <EmptyMedia variant="icon">
                  <FactoryIcon />
                </EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>Factory not found</EmptyTitle>
                  <EmptyDescription>
                    Its folder under .t3/factories was renamed or removed, or its project is gone.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : query.data === null ? (
              <p className="text-sm text-muted-foreground" role="status">
                {query.error ?? "Loading the factory…"}
              </p>
            ) : (
              <FactoryView
                key={query.data.id}
                environmentId={environmentId}
                factory={query.data}
                canManage={access.canManage}
                workItemSearch={props.workItemSearch}
                onWorkItemSearchChange={props.onWorkItemSearchChange}
              />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function ForemanLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  return (
    <Button
      size="xs"
      variant="ghost"
      render={
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId: props.environmentId, threadId: props.threadId }}
        />
      }
    >
      Foreman thread
    </Button>
  );
}

function attentionSummary(factory: Factory) {
  const { gatesWaiting, failedRuns, questions } = factory.attention;
  const parts = [
    gatesWaiting === 0 ? null : `${gatesWaiting} ${gatesWaiting === 1 ? "gate" : "gates"} waiting`,
    failedRuns === 0 ? null : `${failedRuns} failed ${failedRuns === 1 ? "run" : "runs"}`,
    questions === 0 ? null : `${questions} ${questions === 1 ? "question" : "questions"}`,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "Nothing needs you" : parts.join(", ");
}

function FactoryView(props: {
  readonly environmentId: EnvironmentId;
  readonly factory: Factory;
  readonly canManage: boolean;
  readonly workItemSearch: WorkItemSearch;
  readonly onWorkItemSearchChange: (search: WorkItemSearch) => void;
}) {
  const { environmentId } = props;
  const canSave = useAtomValue(factoriesEnvironment.save.permissionAtom(environmentId));
  const save = useAtomCommand(factoriesEnvironment.save, {
    label: "save a factory",
    reportFailure: false,
  });
  const [draft, setDraft] = useState<FactoryDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<{
    readonly message: string;
    readonly issues: ReadonlyArray<FactoryIssue>;
  } | null>(null);
  // The read refreshes after a save lands; until it does, show what the save returned.
  const [saved, setSaved] = useState<{ readonly from: Factory; readonly to: Factory } | null>(null);
  const allProjects = useProjects();
  const environments = useEnvironmentIdentities();
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;

  const factory = saved !== null && saved.from === props.factory ? saved.to : props.factory;
  const editable = props.canManage && canSave;
  const shown = draft ?? factoryDraft(factory);
  const dirty = draft !== null && factoryDraftChanged(factory, draft);
  const project =
    allProjects.find(
      (candidate) =>
        candidate.environmentId === environmentId && candidate.id === factory.projectId,
    ) ?? null;
  const environmentLabel =
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    environmentId;
  const instanceEntries = providerInstanceEntriesFor(providers, settings, factory.projectId);
  const models: FactoryModelChoices = {
    providers,
    settings,
    instanceEntries,
    fallback: scheduledTaskDefaultModel(settings, project, instanceEntries),
  };
  // The read's issues are listed above; a refused save's sit beside the fields they name.
  const issues = refusal?.issues ?? [];
  const edit = (change: (current: FactoryDraft) => FactoryDraft) =>
    setDraft((current) => change(current ?? factoryDraft(factory)));
  const editRole = (role: FactoryRoleName, next: FactoryRoleDraft) =>
    edit((current) => ({ ...current, roles: { ...current.roles, [role]: next } }));

  const submit = async () => {
    if (draft === null || saving) return;
    setSaving(true);
    setRefusal(null);
    const result = await save({
      environmentId,
      input: buildFactorySaveInput(factory, draft),
    });
    setSaving(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      const factoryError = factoryErrorOf(error);
      setRefusal({
        message:
          factoryError?.message ??
          (error instanceof Error ? error.message : "The factory could not be saved."),
        issues: factoryError?.issues ?? [],
      });
      return;
    }
    setSaved({ from: props.factory, to: result.value });
    setDraft(null);
    toastManager.add({ type: "success", title: "Factory saved" });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="truncate text-sm">
            {project?.title ?? "Unknown project"}
            <span className="text-muted-foreground"> on {environmentLabel}</span>
          </p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {attentionSummary(factory)}
            <FactoryAttentionBadge count={factory.attention.total} />
          </p>
        </div>
        {editable ? (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={draft === null || saving}
              onClick={() => {
                setDraft(null);
                setRefusal(null);
              }}
            >
              Discard
            </Button>
            <Button size="sm" disabled={!dirty || saving} onClick={() => void submit()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : null}
      </div>
      {refusal === null ? null : (
        <p role="alert" className="text-sm text-destructive-foreground">
          {refusal.message}
        </p>
      )}
      <FactoryNeedsYou environmentId={environmentId} factory={factory} />
      <FactoryIssuesList issues={factory.issues} />
      <FactoryCanvas environmentId={environmentId} factoryId={factory.id} />
      <FactoryDefinitionSection
        environmentId={environmentId}
        factory={factory}
        projects={shown.projects}
        triggers={shown.triggers}
        editable={editable}
        disabled={saving}
        issues={issues}
        onProjectsChange={(projects) => edit((current) => ({ ...current, projects }))}
        onTriggersChange={(triggers) => edit((current) => ({ ...current, triggers }))}
      />
      <FactoryWorkItems
        environmentId={environmentId}
        factory={factory}
        search={props.workItemSearch}
        onSearchChange={props.onWorkItemSearchChange}
      />
      <FactorySkillsSection
        environmentId={environmentId}
        factory={factory}
        canManage={props.canManage}
      />
      <div className="flex flex-col gap-4">
        <h2 className="font-medium">Roles</h2>
        {factory.roles.map((role) => (
          <FactoryRoleCard
            key={role.role}
            environmentId={environmentId}
            role={role}
            draft={shown.roles[role.role]}
            editable={editable}
            disabled={saving}
            issues={issues}
            models={models}
            onChange={(next) => editRole(role.role, next)}
          />
        ))}
      </div>
    </div>
  );
}
