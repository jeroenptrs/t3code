import { factorySaveInput } from "@t3tools/client-runtime/factories";
import { triggerFiltersSummary } from "@t3tools/client-runtime/scheduled-task-trigger";
import {
  scheduledTaskTrigger,
  type ScheduledTask,
  type ScheduledTaskId,
  type Trigger,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { ChevronDownIcon, PlusIcon, UnlinkIcon } from "lucide-react";
import { useState } from "react";

import type { MessageResolver } from "../../i18n/messages";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { factoriesEnvironment } from "../../state/factories";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
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
import { FactoryIssuesList } from "./FactoryIssues";
import { issuesFor } from "./FactoryPage.logic";
import type { FactoryTabProps } from "./FactoryPage";
import {
  FactoryCardSkeleton,
  FactoryConfirmDialog,
  FactoryLoadError,
  FactoryRowLink,
  ROW_LINK_CLASS,
  useFactoryEditable,
  useFactorySave,
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
  if (source.kind === "jira_query" || source.kind === "gitlab_projects") {
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
  const { editable, blockedReason } = useFactoryEditable(environmentId, factory, props.canManage);
  const { save } = useFactorySave(environmentId);
  const query = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const [editor, setEditor] = useState<Editor | null>(null);
  const [detaching, setDetaching] = useState<ScheduledTaskId | null>(null);
  const tasks = query.data?.tasks ?? null;
  const attached = factory.definition.triggers.map((trigger) => trigger.scheduledTaskId);
  const taskById = new Map((tasks ?? []).map((task) => [task.id, task] as const));
  // Triggers in the factory's project it does not use yet; attaching one is the way back from Detach.
  const attachable = (tasks ?? []).filter(
    (task) => task.projectId === factory.projectId && !attached.includes(task.id),
  );

  const saveTriggers = async (triggers: ReadonlyArray<ScheduledTaskId>) => {
    const result = await save(
      factorySaveInput(factory, {
        definition: {
          triggers: triggers.map((scheduledTaskId) => ({
            kind: "scheduled_task" as const,
            scheduledTaskId,
          })),
        },
      }),
    );
    if ("refusal" in result) return result.refusal.message;
    props.onSaved(result.saved);
    return null;
  };
  const attach = async (taskId: ScheduledTaskId) => {
    if (attached.includes(taskId)) return;
    const failure = await saveTriggers([...attached, taskId]);
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
        onRetry={() => factoriesEnvironment.refresh(appAtomRegistry, environmentId)}
      />
    );
  }

  const detachingTask = detaching === null ? undefined : taskById.get(detaching);
  return (
    <>
      <FactoryIssuesList issues={issuesFor(factory.issues, null, "triggers")} />
      <SettingsSection
        title={gt("Triggers")}
        headerAction={
          editable ? (
            <Group>
              <Button
                size="xs"
                variant="outline"
                disabled={blockedReason !== null}
                title={blockedReason ?? undefined}
                onClick={() => setEditor({ task: null })}
              >
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
                      disabled={blockedReason !== null}
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
          attached.map((taskId) => {
            const task = taskById.get(taskId);
            const detach = editable ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      disabled={blockedReason !== null}
                      aria-label={gt("Detach {title}", { title: task?.title ?? taskId })}
                      onClick={() => setDetaching(taskId)}
                    />
                  }
                >
                  <UnlinkIcon />
                </TooltipTrigger>
                <TooltipPopup>{gt("Detach from this factory")}</TooltipPopup>
              </Tooltip>
            ) : undefined;
            if (task === undefined) {
              return (
                <FactoryRowLink
                  key={taskId}
                  title={gt("Missing trigger")}
                  meta={taskId}
                  trailing={detach}
                />
              );
            }
            return (
              <FactoryRowLink
                key={taskId}
                title={task.title}
                meta={
                  <span className="flex flex-wrap gap-x-3">
                    {triggerFacts(scheduledTaskTrigger(task), messages).map((fact) => (
                      <span key={fact}>{fact}</span>
                    ))}
                  </span>
                }
                trailing={detach}
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
          "The trigger stops sending work to this factory. It stays in Settings, and you can attach it again.",
        )}
        confirmLabel={gt("Detach trigger")}
        onClose={() => setDetaching(null)}
        onConfirm={() => saveTriggers(attached.filter((taskId) => taskId !== detaching))}
      />
      {editor === null ? null : (
        // An empty search is the unscoped view, so the factory's project is always offered.
        <SettingsScopeProvider search={{}} onChange={() => {}}>
          <ScheduledTaskEditorDialog
            initialEnvironmentId={environmentId}
            task={editor.task}
            prefill={editor.task === null ? draftForFactoryTrigger(factory) : undefined}
            onSaved={(task) => {
              if (editor.task === null) void attach(task.id);
            }}
            onClose={() => setEditor(null)}
          />
        </SettingsScopeProvider>
      )}
    </>
  );
}
