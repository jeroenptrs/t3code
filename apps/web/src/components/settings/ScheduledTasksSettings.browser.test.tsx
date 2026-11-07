import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
  type ServerProvider,
  type TriggerTemplate,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { ScheduledTasksSettings } from "./ScheduledTasksSettings";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project");
const task: ScheduledTask = {
  id: ScheduledTaskId.make("nightly"),
  title: "Review issues",
  prompt: "Review open issues",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId,
  threadId: ThreadId.make("older-thread"),
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};

// Stands in for the thread family read the editor makes when the shell lacks the bound thread.
const threadFamilyRead = {
  snapshotSequence: 1,
  threads: [{ id: task.threadId, title: "Fix login bug" }],
};

const template: TriggerTemplate = {
  name: "issue-in-progress",
  title: "Issue enters In Progress",
  source: "jira",
  filters: [{ path: "event.status", op: "equals", value: "{{status}}" }],
  prompt: "Work on {{event.key}} now that it is {{status}}.",
  placeholders: [{ name: "status", default: "In Progress" }],
};
// Stands in for the trigger template list read.
const templatesRead = { templates: [template] };

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-21T00:00:00.000Z",
  models: [
    { slug: "gpt-5.4", name: "GPT-5.4", isDefault: true, isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};
const providersAtom = Atom.make<ReadonlyArray<ServerProvider>>([provider]).pipe(Atom.keepAlive);

const state = vi.hoisted(() => ({
  connected: true,
  tasksLoaded: true,
  secondary: false,
  listed: null as ReadonlyArray<ScheduledTask> | null,
  commands: [] as Array<{ label: string; target: unknown }>,
}));
const secondaryId = EnvironmentId.make("secondary");
const permissions = new Map<string, Atom.Writable<boolean>>();
const templateReadPermissions = new Map<string, Atom.Writable<boolean>>();
const templateWritePermissions = new Map<string, Atom.Writable<boolean>>();

function setup(templates: { read?: boolean; write?: boolean } = {}) {
  state.connected = true;
  state.tasksLoaded = true;
  state.secondary = false;
  state.listed = null;
  state.commands = [];
  permissions.clear();
  permissions.set(environmentId, Atom.make(true));
  permissions.set(secondaryId, Atom.make(true));
  permissions.set("", Atom.make(false));
  templateReadPermissions.clear();
  templateWritePermissions.clear();
  for (const id of [environmentId, secondaryId]) {
    templateReadPermissions.set(id, Atom.make(templates.read ?? true));
    templateWritePermissions.set(id, Atom.make(templates.write ?? true));
  }
  templateReadPermissions.set("", Atom.make(false));
  templateWritePermissions.set("", Atom.make(false));
}

function secondaryEnvironment() {
  return { ...environment(), environmentId: secondaryId, label: "Secondary" };
}

function environment() {
  return {
    environmentId,
    label: "Laptop",
    connection: { phase: state.connected ? "connected" : "disconnected" },
    serverConfig: state.connected
      ? { environment: { platform: "linux", capabilities: { oneTimeSchedules: true } } }
      : null,
  };
}

vi.mock(import("./SettingsScopeContext"), async (original) => {
  const scope = () => {
    const entry = environment();
    return {
      scope: { kind: "all", label: "All", members: [], environmentIds: [environmentId] },
      environments: state.secondary ? [entry, secondaryEnvironment()] : [entry],
      connectedEnvironments: state.connected
        ? state.secondary
          ? [entry, secondaryEnvironment()]
          : [entry]
        : [],
      environment: entry,
      target: null,
      targets: [],
    };
  };
  return {
    ...(await original()),
    useSettingsScope: scope as never,
  };
});
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();

  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      upsertScheduledTask: {
        ...actual.serverEnvironment.upsertScheduledTask,
        permissionAtom: (id: string | null) => permissions.get(id ?? "")!,
      },
      providersValueAtom: (() => providersAtom) as never,
      triggerTemplates: Object.assign(() => templatesRead, {
        permissionAtom: (id: string | null) => templateReadPermissions.get(id ?? "")!,
      }) as never,
      saveTriggerTemplate: {
        ...actual.serverEnvironment.saveTriggerTemplate,
        permissionAtom: (id: string | null) => templateWritePermissions.get(id ?? "")!,
      },
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((_command: unknown, options: { label: string }) => async (target: unknown) => {
    state.commands.push({ label: options.label, target });
    return { _tag: "Success", value: undefined };
  }) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    threadFamilies: { ...actual.threadFamilies, familyAtom: (() => threadFamilyRead) as never },
  };
});
// Mirrors the real query: a null request (disconnected environment) has no data.
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((request: unknown) => ({
    data:
      request === null || request === threadFamilyRead || request === templatesRead
        ? request
        : { tasks: state.tasksLoaded ? (state.listed ?? [task]) : [] },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: ((id: EnvironmentId) =>
    id === secondaryId ? secondaryEnvironment() : environment()) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [{ id: projectId, environmentId, title: "Project" }]) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
}));

describe("ScheduledTasksSettings", () => {
  it("creates on a permitted secondary and reacts to permission changes", async () => {
    setup();
    state.secondary = true;
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    registry.set(permissions.get(environmentId)!, false);
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <ScheduledTasksSettings />
      </RegistryContext.Provider>,
    );
    const create = screen.getByRole("button", { name: "New trigger" });
    await expect.element(create).toBeEnabled();
    await act(() => registry.set(permissions.get(secondaryId)!, false));
    await expect.element(create).toBeDisabled();
    await act(() => registry.set(permissions.get(secondaryId)!, true));
    await expect.element(create).toBeEnabled();
    await create.click();
    await expect.element(page.getByLabelText("Runs on")).toHaveTextContent("Secondary");
  });

  it("keeps the permitted representative as the creation target", async () => {
    setup();
    state.secondary = true;
    await using screen = await render(<ScheduledTasksSettings />);
    await screen.getByRole("button", { name: "New trigger" }).click();
    await expect.element(page.getByLabelText("Runs on")).toHaveTextContent("Laptop");
  });

  it("disables creation without a connected target", async () => {
    setup();
    state.connected = false;
    await using screen = await render(<ScheduledTasksSettings />);
    await expect.element(screen.getByRole("button", { name: "New trigger" })).toBeDisabled();
  });

  it("keeps a linked task's unsaved edits across a disconnect and reconnect", async () => {
    setup();
    await using screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(page.getByRole("dialog").getByText("Fix login bug")).toBeVisible();
    const name = page.getByRole("dialog").getByRole("textbox", { name: "Name" });
    await expect.element(name).toHaveValue("Review issues");
    await userEvent.fill(name, "Review stale issues");

    state.connected = false;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);

    await expect.element(name).toHaveValue("Review stale issues");

    state.connected = true;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(name).toHaveValue("Review stale issues");
  });

  it("keeps an editor the user opened when the linked task loads later", async () => {
    setup();
    state.tasksLoaded = false;
    await using screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await userEvent.click(page.getByRole("button", { name: "New trigger" }));
    const dialog = page.getByRole("dialog");
    const name = dialog.getByRole("textbox", { name: "Name" });
    await userEvent.fill(name, "My draft");

    state.tasksLoaded = true;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);

    await expect.element(dialog.getByRole("heading", { name: "New trigger" })).toBeInTheDocument();
    await expect.element(name).toHaveValue("My draft");
  });

  it("saves a Jira trigger with the picked filter field", async () => {
    setup();
    await using screen = await render(<ScheduledTasksSettings />);
    await screen.getByRole("button", { name: "New trigger" }).click();
    const dialog = page.getByRole("dialog");
    await userEvent.fill(dialog.getByRole("textbox", { name: "Name" }), "Start in-progress issues");
    await dialog.getByLabelText("Source").click();
    await page.getByRole("option", { name: "Jira", exact: true }).click();
    await expect
      .element(dialog.getByRole("textbox", { name: "Prompt" }))
      .toHaveValue("Work on Jira issue {{event.key}}: {{event.summary}} ({{event.url}}).");
    await dialog.getByRole("button", { name: "Add filter" }).click();
    await dialog.getByLabelText("Filter 1 field").click();
    await page.getByRole("option", { name: "Status", exact: true }).click();
    await userEvent.fill(dialog.getByLabelText("Filter 1 value"), "In Progress");
    const actOn = dialog.getByRole("group", { name: "Act on" });
    await actOn.getByRole("button", { name: "issue.labels_changed" }).click();
    await actOn.getByRole("button", { name: "issue.assignee_changed" }).click();
    await dialog.getByLabelText("When the item fits no instruction").click();
    await page.getByRole("option", { name: "Ask and wait" }).click();
    await dialog.getByRole("button", { name: "Create trigger" }).click();

    await vi.waitFor(() =>
      expect(state.commands).toContainEqual({
        label: "scheduled task upsert",
        target: expect.objectContaining({
          input: expect.objectContaining({
            schedule: {
              type: "jira",
              filters: [
                { path: "event.type", op: "in", value: ["issue.status_changed"] },
                { path: "event.status", op: "equals", value: "In Progress" },
              ],
            },
            triage: { fallback: "ask" },
          }),
        }),
      }),
    );
  });

  it("shows a Jira trigger's source and filters on its row", async () => {
    setup();
    state.listed = [
      {
        ...task,
        id: ScheduledTaskId.make("start-issues"),
        title: "Start issues",
        schedule: {
          type: "jira",
          filters: [
            { path: "event.status", op: "equals", value: "In Progress" },
            { path: "event.labels", op: "equals", value: "bug" },
          ],
        },
      },
    ];
    await using screen = await render(<ScheduledTasksSettings />);
    await expect
      .element(
        screen.getByText("Jira · Status equals In Progress, Labels has bug", { exact: false }),
      )
      .toBeVisible();
  });

  it("hides templates without the read scope and blocks edits without the write scope", async () => {
    setup({ read: false, write: false });
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <ScheduledTasksSettings />
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByRole("button", { name: "New trigger" })).toBeEnabled();
    await expect.element(screen.getByText("Trigger templates")).not.toBeInTheDocument();

    await act(() => registry.set(templateReadPermissions.get(environmentId)!, true));
    await expect.element(screen.getByText("Issue enters In Progress")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "New template" })).toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: "Actions for Issue enters In Progress" }))
      .toBeDisabled();
  });

  it("fills a new trigger from a template", async () => {
    setup({ write: false });
    await using screen = await render(<ScheduledTasksSettings />);
    await screen.getByRole("button", { name: "Use Issue enters In Progress" }).click();
    const values = page.getByRole("dialog", { name: "Use Issue enters In Progress" });
    await expect
      .element(values.getByRole("textbox", { name: "status" }))
      .toHaveValue("In Progress");
    await userEvent.fill(values.getByRole("textbox", { name: "status" }), "Review");
    await values.getByRole("button", { name: "Create trigger" }).click();

    const editor = page.getByRole("dialog", { name: "New trigger" });
    await expect
      .element(editor.getByRole("textbox", { name: "Name" }))
      .toHaveValue("Issue enters In Progress");
    await expect.element(editor.getByLabelText("Source")).toHaveTextContent("Jira");
    await expect.element(editor.getByLabelText("Filter 1 field")).toHaveTextContent("Status");
    await expect.element(editor.getByLabelText("Filter 1 value")).toHaveValue("Review");
    await expect
      .element(editor.getByRole("textbox", { name: "Prompt" }))
      .toHaveValue("Work on {{event.key}} now that it is Review.");
  });
});
