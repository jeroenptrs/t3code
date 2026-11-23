import { useAtomValue } from "@effect/atom-react";
import { triggerFiltersSummary } from "@t3tools/client-runtime/scheduled-task-trigger";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  scheduledTaskTrigger,
  type FactoryId,
  type ScheduledTask,
  type ScheduledTaskId,
  type Trigger,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ListIcon, PlusIcon, UnlinkIcon } from "lucide-react";
import { useState } from "react";

import type { MessageResolver } from "../../i18n/messages";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { factoriesEnvironment } from "../../state/factories";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ScheduledTaskEditorDialog } from "../settings/ScheduledTasksSettings";
import {
  draftForFactoryTrigger,
  isTriggerFilterSource,
} from "../settings/scheduledTasksSettings.logic";
import { SettingsScopeProvider } from "../settings/SettingsScopeContext";
import { SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { FACTORY_ROUTE } from "./FactoryPage.logic";
import type { FactoryTabProps } from "./FactoryPage";
import {
  FactoryCardSkeleton,
  FactoryConfirmDialog,
  FactoryLoadError,
  FactoryRowLink,
  ROW_LINK_CLASS,
} from "./FactoryPageParts";

const SOURCE_LABELS: Record<Trigger["source"]["kind"], string> = {
  schedule: msg("Schedule", { $context: "trigger source" }),
  webhook: msg("Webhook", { $context: "trigger source" }),
  jira: msg("Jira events"),
  gitlab: msg("GitLab events"),
  slack: msg("Slack events"),
  manual: msg("Started by hand"),
  jira_query: msg("Jira query"),
  gitlab_projects: msg("GitLab projects"),
  issues: msg("Issues", { $context: "trigger source" }),
  pull_requests: msg("Pull requests", { $context: "trigger source" }),
};

/** Where a trigger's work comes from, what it filters on, and what a polled one acts on first. */
function triggerFacts(trigger: Trigger, resolve: MessageResolver): ReadonlyArray<string> {
  const { source, filters } = trigger;
  const facts = [resolve(SOURCE_LABELS[source.kind])];
  if (source.kind === "webhook" && filters.length > 0) {
    facts.push(
      resolve(
        msg("{count, plural, =1 {One filter} other {{count} filters}}", { count: filters.length }),
      ),
    );
  } else if (isTriggerFilterSource(source.kind) && filters.length > 0) {
    // Field names and values, as the trigger form writes them.
    facts.push(triggerFiltersSummary(source.kind, filters));
  }
  if (
    source.kind === "jira_query" ||
    source.kind === "gitlab_projects" ||
    source.kind === "issues" ||
    source.kind === "pull_requests"
  ) {
    facts.push(
      (source.start ?? "changes") === "current"
        ? resolve(msg("First check acts on everything it finds"))
        : resolve(msg("First check acts on changes after it")),
    );
  }
  return facts;
}

type Editor = { readonly task: ScheduledTask | null };

export function FactoryTriggersTab(props: FactoryTabProps) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId, factory } = props;
  const editable =
    useAtomValue(serverEnvironment.setTriggerTarget.permissionAtom(environmentId)) &&
    props.canManage;
  const setTarget = useAtomCommand(serverEnvironment.setTriggerTarget, {
    label: "trigger set target",
  });
  const query = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const [editor, setEditor] = useState<Editor | null>(null);
  const [detaching, setDetaching] = useState<ScheduledTaskId | null>(null);
  const tasks = query.data?.tasks ?? null;
  // A trigger belongs to the factory its target names; nothing else links them.
  const attached = (tasks ?? []).filter((task) => task.target?.factoryId === factory.id);
  const taskById = new Map(attached.map((task) => [task.id, task] as const));
  // A trigger of another factory moves here when attached, since a trigger has one target.
  const attachable = (tasks ?? []).filter(
    (task) => task.projectId === factory.projectId && task.target?.factoryId !== factory.id,
  );

  const changeTarget = async (taskId: ScheduledTaskId, factoryId: FactoryId | null) => {
    const result = await setTarget({ environmentId, input: { id: taskId, factoryId } });
    if (result._tag === "Success") {
      // The factory read lists its triggers for the canvas and the sidebar.
      factoriesEnvironment.refresh(appAtomRegistry, environmentId);
      return null;
    }
    return isAtomCommandInterrupted(result) ? null : String(squashAtomCommandFailure(result));
  };
  const attach = async (taskId: ScheduledTaskId) => {
    const failure = await changeTarget(taskId, factory.id);
    toastManager.add(
      failure === null
        ? { type: "success", title: gt("Trigger attached") }
        : { type: "error", title: gt("Could not attach the trigger"), description: failure },
    );
  };

  if (tasks === null) {
    return query.error === null ? (
      <FactoryCardSkeleton />
    ) : (
      <FactoryLoadError
        title={gt("Could not load triggers")}
        message={query.error}
        onRetry={query.refresh}
      />
    );
  }

  const detachingTask = detaching === null ? undefined : taskById.get(detaching);
  return (
    <>
      <SettingsSection
        title={gt("Triggers")}
        headerAction={
          editable ? (
            <Group>
              <Button size="xs" variant="outline" onClick={() => setEditor({ task: null })}>
                <PlusIcon />
                <T>Add trigger</T>
              </Button>
              <GroupSeparator />
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="outline"
                      aria-label={gt("Attach an existing trigger")}
                    />
                  }
                >
                  <ChevronDownIcon />
                </MenuTrigger>
                <MenuPopup align="end" className="max-h-80">
                  {attachable.length === 0 ? (
                    <MenuItem disabled>
                      <T>No other triggers in this project</T>
                    </MenuItem>
                  ) : (
                    attachable.map((task) => (
                      <MenuItem key={task.id} onClick={() => void attach(task.id)}>
                        {task.title}
                      </MenuItem>
                    ))
                  )}
                </MenuPopup>
              </Menu>
            </Group>
          ) : null
        }
      >
        {attached.length === 0 ? (
          <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
            <T>No triggers. Work arrives only when someone sends it.</T>
          </p>
        ) : (
          attached.map((task) => {
            const detach = editable ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={gt("Detach {title}", { title: task.title })}
                      onClick={() => setDetaching(task.id)}
                    />
                  }
                >
                  <UnlinkIcon />
                </TooltipTrigger>
                <TooltipPopup>{gt("Detach from this factory")}</TooltipPopup>
              </Tooltip>
            ) : undefined;
            return (
              <FactoryRowLink
                key={task.id}
                title={task.title}
                meta={
                  <span className="flex flex-wrap gap-x-3">
                    {[
                      ...(task.enabled ? [] : [gt("Off")]),
                      ...triggerFacts(scheduledTaskTrigger(task), messages),
                    ].map((fact) => (
                      <span key={fact}>{fact}</span>
                    ))}
                  </span>
                }
                trailing={
                  <>
                    {task.schedule.type === "jira_query" ? (
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        render={
                          <Link
                            to={FACTORY_ROUTE}
                            params={{ environmentId, factoryId: factory.id }}
                            search={{ tab: "triggers", trigger: task.id }}
                          />
                        }
                      >
                        <ListIcon />
                        <T>Issues</T>
                      </Button>
                    ) : null}
                    {detach}
                  </>
                }
                link={
                  <button
                    type="button"
                    className={ROW_LINK_CLASS}
                    aria-label={task.title}
                    onClick={() => setEditor({ task })}
                  />
                }
              />
            );
          })
        )}
      </SettingsSection>
      <FactoryConfirmDialog
        open={detaching !== null}
        title={gt("Detach {title}?", { title: detachingTask?.title ?? detaching ?? "" })}
        description={gt(
          "The trigger stops sending work to this factory and turns off. It stays in Settings, and you can attach it again.",
        )}
        confirmLabel={gt("Detach trigger")}
        onClose={() => setDetaching(null)}
        onConfirm={() =>
          detaching === null ? Promise.resolve(null) : changeTarget(detaching, null)
        }
      />
      {editor === null ? null : (
        // An empty search is the unscoped view, so the factory's project is always offered.
        <SettingsScopeProvider search={{}} onChange={() => {}}>
          <ScheduledTaskEditorDialog
            initialEnvironmentId={environmentId}
            task={editor.task}
            prefill={editor.task === null ? draftForFactoryTrigger(factory) : undefined}
            onClose={() => setEditor(null)}
          />
        </SettingsScopeProvider>
      )}
    </>
  );
}
