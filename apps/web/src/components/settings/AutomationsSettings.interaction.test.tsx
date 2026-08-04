// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledAutomationId,
  type ScheduledAutomation,
  type ScheduledAutomationCommand,
  type ScheduledAutomationView,
  type ServerProvider,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const branchMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  loadNext: vi.fn(),
  hook: vi.fn(),
}));

vi.mock("../../state/queries", () => ({
  usePaginatedBranches: branchMocks.hook,
}));

import {
  AutomationEditor,
  AutomationRow,
  type AutomationsSettingsProps,
} from "./AutomationsSettings";
import { DELETE_AUTOMATION_DISCLOSURE } from "./AutomationsSettings.logic";

const NOW = "2026-08-04T12:00:00.000Z";
const ENVIRONMENT_ID = EnvironmentId.make("environment-one");
const PROJECT_ID = ProjectId.make("project-one");
const SECOND_PROJECT_ID = ProjectId.make("project-two");
const CODEX_ID = ProviderInstanceId.make("codex");

const providers: ReadonlyArray<ServerProvider> = [
  {
    instanceId: CODEX_ID,
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "warning",
    auth: { status: "authenticated" },
    checkedAt: NOW,
    models: [
      {
        slug: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        isCustom: false,
        isDefault: true,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High", isDefault: true },
              ],
            },
            { id: "fastMode", label: "Fast mode", type: "boolean", currentValue: false },
          ],
        },
      },
      {
        slug: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: [{ id: "medium", label: "Medium", isDefault: true }],
            },
          ],
        },
      },
    ],
    slashCommands: [],
    skills: [],
  },
];

const projects: AutomationsSettingsProps["projects"] = [
  {
    id: PROJECT_ID,
    title: "Project one",
    workspaceRoot: "/workspace/one",
    repositoryIdentity: null,
    defaultModelSelection: null,
    environmentId: ENVIRONMENT_ID,
  },
  {
    id: SECOND_PROJECT_ID,
    title: "Project two",
    workspaceRoot: "/workspace/two",
    repositoryIdentity: null,
    defaultModelSelection: null,
    environmentId: ENVIRONMENT_ID,
  },
];

function automation(overrides: Partial<ScheduledAutomation> = {}): ScheduledAutomation {
  return {
    id: ScheduledAutomationId.make("weekday-review"),
    revision: 4,
    name: "Weekday review",
    prompt: "Review open changes.",
    projectId: PROJECT_ID,
    modelSelection: {
      instanceId: CODEX_ID,
      model: "gpt-5.6-sol",
      options: [
        { id: "effort", value: "high" },
        { id: "fastMode", value: false },
      ],
    },
    runtimeMode: "auto-accept-edits",
    interactionMode: "plan",
    worktreePolicy: { kind: "new-worktree", baseBranch: "main", startFromOrigin: true },
    setupScriptPolicy: "skip",
    schedule: {
      cron: "0 9 * * 1-5",
      timeZone: "America/New_York",
      misfirePolicy: "latest-only",
    },
    enabled: false,
    enabledAt: null,
    lastScheduledFor: null,
    lastThreadId: null,
    lastOutcome: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function editor(
  onCommand: (command: ScheduledAutomationCommand) => Promise<ScheduledAutomation | null>,
  overrides: Partial<React.ComponentProps<typeof AutomationEditor>> = {},
) {
  return (
    <AutomationEditor
      open
      existing={null}
      projects={projects}
      providers={providers}
      onOpenChange={vi.fn()}
      onCommand={onCommand}
      onConflict={vi.fn()}
      {...overrides}
    />
  );
}

function fillRequiredCreateFields() {
  fireEvent.change(screen.getByLabelText("Automation ID"), {
    target: { value: "weekday-review" },
  });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Weekday review" } });
  fireEvent.change(screen.getByLabelText("Prompt"), {
    target: { value: "Review open changes and summarize risks." },
  });
}

beforeEach(() => {
  branchMocks.refresh.mockReset();
  branchMocks.loadNext.mockReset();
  branchMocks.hook.mockReset();
  branchMocks.hook.mockReturnValue({
    data: {
      refs: [{ name: "main", kind: "branch" }],
      isRepo: true,
      hasPrimaryRemote: true,
      nextCursor: 25,
      totalCount: 1,
    },
    refs: [{ name: "main", kind: "branch" }],
    error: null,
    isPending: false,
    isFetchingNextPage: false,
    refresh: branchMocks.refresh,
    loadNext: branchMocks.loadNext,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.getAnimations = vi.fn(() => []);
});

afterEach(cleanup);

describe("AutomationEditor interaction wiring", () => {
  it("drives every create field and sends the exact command through onCommand", async () => {
    const onCommand = vi.fn<(command: ScheduledAutomationCommand) => Promise<null>>(
      async () => null,
    );
    render(editor(onCommand));
    fillRequiredCreateFields();
    fireEvent.change(screen.getByLabelText("Runtime mode"), {
      target: { value: "approval-required" },
    });
    fireEvent.change(screen.getByLabelText("Interaction mode"), {
      target: { value: "plan" },
    });
    fireEvent.click(screen.getByLabelText(/New worktree/));
    await waitFor(() => expect(branchMocks.refresh).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Base branch"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Start from origin" }));
    fireEvent.change(screen.getByLabelText("Cron schedule"), {
      target: { value: "30 7 * * 1-5" },
    });
    fireEvent.change(screen.getByLabelText("IANA timezone"), {
      target: { value: "Europe/Paris" },
    });
    fireEvent.change(screen.getByLabelText("Provider and model"), {
      target: { value: JSON.stringify([CODEX_ID, "gpt-5.6-terra"]) },
    });
    fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "medium" } });
    fireEvent.change(screen.getByLabelText("Search branches"), { target: { value: "mai" } });
    await waitFor(() =>
      expect(branchMocks.hook).toHaveBeenLastCalledWith(expect.objectContaining({ query: "mai" })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Load more branches" }));
    expect(branchMocks.loadNext).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Save automation" }));

    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0]![0]).toMatchObject({
      type: "scheduledAutomation.create",
      automationId: "weekday-review",
      definition: {
        name: "Weekday review",
        prompt: "Review open changes and summarize risks.",
        projectId: PROJECT_ID,
        modelSelection: {
          instanceId: CODEX_ID,
          model: "gpt-5.6-terra",
          options: [{ id: "effort", value: "medium" }],
        },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        worktreePolicy: { kind: "new-worktree", baseBranch: "main", startFromOrigin: false },
        setupScriptPolicy: "skip",
        schedule: {
          cron: "30 7 * * 1-5",
          timeZone: "Europe/Paris",
          misfirePolicy: "latest-only",
        },
      },
    });
  });

  it("preserves edits across capability rerenders and refreshes branches per project", async () => {
    const onCommand = vi.fn<(command: ScheduledAutomationCommand) => Promise<null>>(
      async () => null,
    );
    const rendered = render(editor(onCommand));
    fillRequiredCreateFields();
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Unsaved prompt" } });
    fireEvent.click(screen.getByLabelText(/New worktree/));
    await waitFor(() => expect(branchMocks.refresh).toHaveBeenCalledTimes(1));

    rendered.rerender(editor(onCommand, { projects: [...projects], providers: [...providers] }));
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Unsaved prompt");
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: SECOND_PROJECT_ID } });
    await waitFor(() => expect(branchMocks.refresh).toHaveBeenCalledTimes(2));
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Unsaved prompt");
    fireEvent.click(screen.getByLabelText(/Current workspace/));
    fireEvent.click(screen.getByLabelText(/New worktree/));
    await waitFor(() => expect(branchMocks.refresh).toHaveBeenCalledTimes(3));
  });

  it("drives the edit controls and sends an update bound to the visible revision", async () => {
    const existing = automation();
    const onCommand = vi.fn<(command: ScheduledAutomationCommand) => Promise<null>>(
      async () => null,
    );
    render(editor(onCommand, { existing }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Edited review" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Edited prompt" } });
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: SECOND_PROJECT_ID } });
    fireEvent.change(screen.getByLabelText("Runtime mode"), { target: { value: "full-access" } });
    fireEvent.change(screen.getByLabelText("Interaction mode"), { target: { value: "default" } });
    fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "low" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Fast mode" }));
    fireEvent.click(screen.getByLabelText(/Current workspace/));
    fireEvent.change(screen.getByLabelText("Cron schedule"), { target: { value: "15 6 * * *" } });
    fireEvent.change(screen.getByLabelText("IANA timezone"), { target: { value: "UTC" } });
    fireEvent.click(screen.getByRole("button", { name: "Save automation" }));

    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0]![0]).toMatchObject({
      type: "scheduledAutomation.update",
      automationId: existing.id,
      expectedRevision: 4,
      definition: {
        name: "Edited review",
        prompt: "Edited prompt",
        projectId: SECOND_PROJECT_ID,
        modelSelection: {
          instanceId: CODEX_ID,
          model: "gpt-5.6-sol",
          options: [
            { id: "effort", value: "low" },
            { id: "fastMode", value: true },
          ],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        worktreePolicy: { kind: "current" },
        setupScriptPolicy: "skip",
        schedule: { cron: "15 6 * * *", timeZone: "UTC", misfirePolicy: "latest-only" },
      },
    });
  });

  it("locks a duplicate-create conflict to the server identity and requires a manual retry", async () => {
    const current = automation({
      id: ScheduledAutomationId.make("server-automation"),
      revision: 9,
      name: "Server automation",
    });
    const onCommand = vi
      .fn<(command: ScheduledAutomationCommand) => Promise<ScheduledAutomation | null>>()
      .mockRejectedValueOnce({ _tag: "ScheduledAutomationConflictError", current })
      .mockRejectedValueOnce({
        _tag: "ScheduledAutomationValidationError",
        field: "name",
        message: "Review the server name.",
      })
      .mockResolvedValueOnce(current);
    const rendered = render(editor(onCommand));
    fillRequiredCreateFields();
    fireEvent.click(screen.getByRole("button", { name: "Save automation" }));

    await screen.findByText(/server revision 9/);
    rendered.rerender(editor(onCommand, { projects: [...projects], providers: [...providers] }));
    expect(screen.getByText(/server revision 9/)).toBeTruthy();
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Automation ID") as HTMLInputElement).value).toBe(
      "server-automation",
    );
    expect((screen.getByLabelText("Automation ID") as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Reviewed server row" } });
    fireEvent.click(screen.getByRole("button", { name: "Save automation" }));

    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2));
    expect(onCommand.mock.calls[1]![0]).toMatchObject({
      type: "scheduledAutomation.update",
      automationId: current.id,
      expectedRevision: 9,
      definition: { name: "Reviewed server row" },
    });
    expect(await screen.findByText("Review the server name.")).toBeTruthy();
    expect((screen.getByLabelText("Automation ID") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(3));
    expect(onCommand.mock.calls[2]![0]).toMatchObject({
      type: "scheduledAutomation.update",
      automationId: current.id,
      expectedRevision: 9,
    });
  });

  it("allows a disabled row to edit non-capability fields while locked selections are unavailable", async () => {
    const existing = automation({
      projectId: ProjectId.make("missing-project"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("missing-provider"),
        model: "missing-model",
      },
      worktreePolicy: { kind: "new-worktree", baseBranch: "archived", startFromOrigin: true },
    });
    branchMocks.hook.mockReturnValue({
      data: null,
      refs: [],
      error: null,
      isPending: false,
      isFetchingNextPage: false,
      refresh: branchMocks.refresh,
      loadNext: branchMocks.loadNext,
    });
    const onCommand = vi.fn<(command: ScheduledAutomationCommand) => Promise<null>>(
      async () => null,
    );
    render(editor(onCommand, { existing, projects: [], providers: [] }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Edited offline" } });
    const save = screen.getByRole("button", { name: "Save automation" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0]![0]).toMatchObject({
      type: "scheduledAutomation.update",
      automationId: existing.id,
      expectedRevision: existing.revision,
      definition: {
        name: "Edited offline",
        projectId: existing.projectId,
        modelSelection: existing.modelSelection,
        worktreePolicy: existing.worktreePolicy,
      },
    });
  });

  it("renders server field errors at the actual cron control", async () => {
    const onCommand = vi.fn(async () => {
      throw {
        _tag: "ScheduledAutomationValidationError",
        field: "schedule.cron",
        message: "Cron must contain exactly five fields.",
      };
    });
    render(editor(onCommand));
    fillRequiredCreateFields();
    fireEvent.change(screen.getByLabelText("Cron schedule"), { target: { value: "bad cron" } });
    fireEvent.click(screen.getByRole("button", { name: "Save automation" }));

    expect(await screen.findByText("Cron must contain exactly five fields.")).toBeTruthy();
    expect(screen.getByLabelText(/^Cron schedule/).getAttribute("aria-invalid")).toBe("true");
  });

  it("renders server timezone errors at the actual timezone control", async () => {
    const onCommand = vi.fn(async () => {
      throw {
        _tag: "ScheduledAutomationValidationError",
        field: "schedule.timeZone",
        message: "Use an IANA timezone.",
      };
    });
    render(editor(onCommand));
    fillRequiredCreateFields();
    fireEvent.change(screen.getByLabelText("IANA timezone"), { target: { value: "Mars/Base" } });
    fireEvent.click(screen.getByRole("button", { name: "Save automation" }));

    expect(await screen.findByText("Use an IANA timezone.")).toBeTruthy();
    expect(screen.getByLabelText(/^IANA timezone/).getAttribute("aria-invalid")).toBe("true");
  });

  it("renders branch query, non-Git, and server worktree-policy errors", async () => {
    branchMocks.hook.mockReturnValue({
      data: {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      },
      refs: [],
      error: "Failed to load refs.",
      isPending: false,
      isFetchingNextPage: false,
      refresh: branchMocks.refresh,
      loadNext: branchMocks.loadNext,
    });
    const onCommand = vi.fn(async () => {
      throw {
        _tag: "ScheduledAutomationValidationError",
        field: "worktreePolicy",
        message: "Server rejected the worktree policy.",
      };
    });
    render(editor(onCommand, { existing: automation() }));
    expect(screen.getByText("Failed to load refs.")).toBeTruthy();
    expect(screen.getByText("New worktrees require a Git project.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
    expect(await screen.findByText("Server rejected the worktree policy.")).toBeTruthy();
  });

  it("renders a server base-branch error at the branch selector", async () => {
    const onCommand = vi.fn(async () => {
      throw {
        _tag: "ScheduledAutomationValidationError",
        field: "worktreePolicy.baseBranch",
        message: "The selected base branch is unavailable.",
      };
    });
    render(
      editor(onCommand, {
        existing: automation({ enabled: true, enabledAt: NOW }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save automation" }));

    expect(await screen.findByText("The selected base branch is unavailable.")).toBeTruthy();
    expect(screen.getByLabelText(/^Base branch/).getAttribute("aria-invalid")).toBe("true");
  });
});

describe("AutomationRow safety actions", () => {
  it("gates deletion behind the disabled state and explicit disclosure", async () => {
    const onAction = vi.fn(async () => undefined);
    const view: ScheduledAutomationView = {
      automation: automation(),
      status: "never-run",
      nextScheduledFor: null,
      lastThread: null,
    };
    render(
      <AutomationRow
        environmentId={ENVIRONMENT_ID}
        view={view}
        project={projects[0]}
        provider={providers[0]}
        pending={false}
        onEdit={vi.fn()}
        onAction={onAction}
      />,
    );
    expect(screen.getByText("Never run")).toBeTruthy();
    expect(screen.queryByText(/status never run/)).toBeNull();
    fireEvent.click(screen.getByLabelText("Delete Weekday review"));
    expect(await screen.findByText(DELETE_AUTOMATION_DISCLOSURE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete automation" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("delete"));
  });

  it("disables all row mutations while a command is pending", () => {
    const view: ScheduledAutomationView = {
      automation: automation(),
      status: "never-run",
      nextScheduledFor: null,
      lastThread: null,
    };
    render(
      <AutomationRow
        environmentId={ENVIRONMENT_ID}
        view={view}
        project={projects[0]}
        provider={providers[0]}
        pending
        onEdit={vi.fn()}
        onAction={vi.fn(async () => undefined)}
      />,
    );
    expect((screen.getByRole("button", { name: "Enable" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Retry last" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByLabelText("Delete Weekday review") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByLabelText("Edit Weekday review") as HTMLButtonElement).disabled).toBe(true);
  });
});
