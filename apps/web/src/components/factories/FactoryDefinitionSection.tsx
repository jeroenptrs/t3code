import {
  type EnvironmentId,
  type Factory,
  type FactoryIssue,
  type ScheduledTaskId,
  scheduledTaskTrigger,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { ScheduledTaskEditorDialog } from "../settings/ScheduledTasksSettings";
import { draftForFactoryTrigger } from "../settings/scheduledTasksSettings.logic";
import { SettingsScopeProvider } from "../settings/SettingsScopeContext";
import { Button, InlineButton } from "../ui/button";
import { Label } from "../ui/label";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { factoryTriggerSummary } from "./factories.logic";
import { FactoryFieldIssues } from "./FactoryIssues";
import { issuesFor } from "./FactoryPage.logic";

function countLabel(count: number, noun: string, plural = `${noun}s`) {
  return count === 0 ? "None" : `${count} ${count === 1 ? noun : plural}`;
}

function toggled<T>(list: ReadonlyArray<T>, value: T, checked: boolean): ReadonlyArray<T> {
  return checked
    ? [...list.filter((entry) => entry !== value), value]
    : list.filter((entry) => entry !== value);
}

/** Which projects the factory may work in, and which triggers start its work. */
export function FactoryDefinitionSection(props: {
  readonly environmentId: EnvironmentId;
  readonly factory: Factory;
  readonly projects: ReadonlyArray<string>;
  readonly triggers: ReadonlyArray<ScheduledTaskId>;
  readonly editable: boolean;
  readonly disabled: boolean;
  readonly issues: ReadonlyArray<FactoryIssue>;
  readonly onProjectsChange: (projects: ReadonlyArray<string>) => void;
  readonly onTriggersChange: (triggers: ReadonlyArray<ScheduledTaskId>) => void;
  /** A trigger made with Add trigger, for the page to attach. */
  readonly onTriggerCreated: (taskId: ScheduledTaskId) => void;
}) {
  const { environmentId, factory } = props;
  const [addingTrigger, setAddingTrigger] = useState(false);
  const allProjects = useProjects();
  const tasks =
    useEnvironmentQuery(serverEnvironment.scheduledTasksLive({ environmentId, input: {} })).data
      ?.tasks ?? null;
  const here = allProjects.filter((project) => project.environmentId === environmentId);
  const titleCounts = new Map<string, number>();
  for (const project of here) {
    titleCounts.set(project.title, (titleCounts.get(project.title) ?? 0) + 1);
  }
  const resolution = (name: string) => {
    const count = titleCounts.get(name) ?? 0;
    return count === 1
      ? null
      : count === 0
        ? "Not found here"
        : "More than one project has this name";
  };
  // The owning project is implied, so it is not offered.
  const projectChoices = [
    ...new Set([
      ...here
        .filter((project) => project.id !== factory.projectId && project.archivedAt == null)
        .map((project) => project.title)
        .toSorted((left, right) => left.localeCompare(right)),
      ...props.projects,
    ]),
  ];
  const projectTasks = tasks?.filter((task) => task.projectId === factory.projectId) ?? [];
  const taskChoices = [
    ...projectTasks.map((task) => task.id),
    ...props.triggers.filter((taskId) => !projectTasks.some((task) => task.id === taskId)),
  ];
  const taskById = new Map((tasks ?? []).map((task) => [task.id, task] as const));

  return (
    <section className="grid gap-6 sm:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Label>Projects</Label>
          {props.editable ? (
            <Menu>
              <MenuTrigger
                render={<InlineButton tone="picker" disabled={props.disabled} />}
                aria-label="Choose projects"
              >
                {countLabel(props.projects.length, "project")}
                <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
              </MenuTrigger>
              <MenuPopup align="end">
                {projectChoices.length === 0 ? (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">
                    No other projects here
                  </p>
                ) : null}
                {projectChoices.map((name) => (
                  <MenuCheckboxItem
                    key={name}
                    checked={props.projects.includes(name)}
                    closeOnClick={false}
                    onCheckedChange={(checked) =>
                      props.onProjectsChange(toggled(props.projects, name, checked))
                    }
                  >
                    {name}
                  </MenuCheckboxItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Besides its own project, where the factory may work.
        </p>
        <ul className="flex flex-col gap-1 text-sm">
          {props.projects.length === 0 ? (
            <li className="text-muted-foreground">Only its own project</li>
          ) : null}
          {props.projects.map((name) => {
            const problem = resolution(name);
            return (
              <li key={name} className="flex min-w-0 items-baseline gap-2">
                <span className="truncate">{name}</span>
                {problem === null ? null : (
                  <span className="shrink-0 text-xs text-warning-foreground">{problem}</span>
                )}
              </li>
            );
          })}
        </ul>
        <FactoryFieldIssues issues={issuesFor(props.issues, null, "projects")} />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Label>Triggers</Label>
          {props.editable ? (
            <div className="flex items-center gap-1">
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={props.disabled}
                onClick={() => setAddingTrigger(true)}
              >
                <PlusIcon className="size-3" />
                Add trigger
              </Button>
              <Menu>
                <MenuTrigger
                  render={<InlineButton tone="picker" disabled={props.disabled} />}
                  aria-label="Choose triggers"
                >
                  {countLabel(props.triggers.length, "trigger")}
                  <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                </MenuTrigger>
                <MenuPopup align="end">
                  {taskChoices.length === 0 ? (
                    <p className="px-2 py-1.5 text-sm text-muted-foreground">
                      {tasks === null ? "Loading triggers…" : "No triggers in this project"}
                    </p>
                  ) : null}
                  {taskChoices.map((taskId) => (
                    <MenuCheckboxItem
                      key={taskId}
                      checked={props.triggers.includes(taskId)}
                      closeOnClick={false}
                      onCheckedChange={(checked) =>
                        props.onTriggersChange(toggled(props.triggers, taskId, checked))
                      }
                    >
                      {taskById.get(taskId)?.title ?? "Missing trigger"}
                    </MenuCheckboxItem>
                  ))}
                </MenuPopup>
              </Menu>
            </div>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">Triggers that send work into the factory.</p>
        <ul className="flex flex-col gap-1 text-sm">
          {props.triggers.length === 0 ? <li className="text-muted-foreground">None</li> : null}
          {props.triggers.map((taskId) => {
            const task = taskById.get(taskId);
            return (
              <li key={taskId} className="flex min-w-0 items-baseline gap-2">
                {task === undefined ? (
                  <span className="truncate text-muted-foreground">
                    {tasks === null ? "Loading…" : "Missing trigger"}
                  </span>
                ) : (
                  <>
                    <Link
                      to="/settings/scheduled-tasks"
                      search={{ environmentId, taskId }}
                      className="truncate underline-offset-2 hover:underline"
                    >
                      {task.title}
                    </Link>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {factoryTriggerSummary(scheduledTaskTrigger(task))}
                    </span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        <FactoryFieldIssues issues={issuesFor(props.issues, null, "triggers")} />
      </div>
      {addingTrigger ? (
        // An empty search is the unscoped view, so the factory's project is always offered.
        <SettingsScopeProvider search={{}} onChange={() => {}}>
          <ScheduledTaskEditorDialog
            initialEnvironmentId={environmentId}
            task={null}
            prefill={draftForFactoryTrigger(factory)}
            onSaved={(task) => props.onTriggerCreated(task.id)}
            onClose={() => setAddingTrigger(false)}
          />
        </SettingsScopeProvider>
      ) : null}
    </section>
  );
}
