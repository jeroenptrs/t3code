import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ScheduledAutomationId,
  ScheduledAutomationOutcome,
  SCHEDULED_AUTOMATION_ABANDONED_CODE,
  SCHEDULED_AUTOMATION_BOOTSTRAP_PHASE_REJECTED_CODE,
  ThreadId,
  isScheduledAutomationProviderEligible,
  type ScheduledAutomation,
  type ScheduledAutomationDefinitionDraft,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  automationDraftFromRow,
  applyAutomationConflictRows,
  buildAutomationRevisionCommand,
  buildAutomationSaveCommand,
  canAbandonAutomation,
  canDeleteAutomation,
  canRetryAutomation,
  canSubmitAutomationDraft,
  changeAutomationProject,
  CURRENT_WORKSPACE_DISCLOSURE,
  ABANDON_AUTOMATION_DISCLOSURE,
  DELETE_AUTOMATION_DISCLOSURE,
  DISABLE_AUTOMATION_DISCLOSURE,
  isValidAutomationId,
  liveModelSelection,
  normalizeProviderOptions,
  NEW_WORKTREE_DISCLOSURE,
  reconcileAutomationCommandFailure,
} from "./AutomationsSettings.logic";
import { AutomationFieldError } from "./AutomationsSettings";

const NOW = "2026-08-04T12:00:00.000Z";
const COMMAND_ID = CommandId.make("00000000-0000-4000-8000-000000000001");
const PROJECT_ID = ProjectId.make("project-one");
const AUTOMATION_ID = ScheduledAutomationId.make("weekday-review");
const CODEX_ID = ProviderInstanceId.make("codex");
const decodeOutcome = Schema.decodeUnknownSync(ScheduledAutomationOutcome);

const providers: ReadonlyArray<ServerProvider> = [
  {
    instanceId: CODEX_ID,
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
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

const definition: ScheduledAutomationDefinitionDraft = {
  name: "Weekday review",
  prompt: "Review open changes and summarize risks.",
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
  schedule: { cron: "0 9 * * 1-5", timeZone: "America/New_York", misfirePolicy: "latest-only" },
};

function automation(overrides: Partial<ScheduledAutomation> = {}): ScheduledAutomation {
  return {
    id: AUTOMATION_ID,
    revision: 4,
    ...definition,
    setupScriptPolicy: "skip",
    schedule: { ...definition.schedule, misfirePolicy: "latest-only" },
    enabled: false,
    enabledAt: null,
    lastScheduledFor: "2026-08-03T13:00:00.000Z",
    lastThreadId: ThreadId.make("thread-existing"),
    lastOutcome: {
      kind: "failed",
      scheduledFor: "2026-08-03T13:00:00.000Z",
      observedAt: "2026-08-03T13:00:01.000Z",
      coalescedCount: 0,
      code: "provider.unavailable",
      detail: "Provider unavailable.",
      retryable: true,
    },
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-03T13:00:01.000Z",
    ...overrides,
  };
}

describe("AutomationsSettings command payloads", () => {
  it("creates with every definition field and no implicit enablement", () => {
    expect(
      buildAutomationSaveCommand({
        automationId: AUTOMATION_ID,
        definition,
        commandId: COMMAND_ID,
        now: NOW,
      }),
    ).toEqual({
      type: "scheduledAutomation.create",
      commandId: COMMAND_ID,
      automationId: AUTOMATION_ID,
      definition,
      createdAt: NOW,
    });
  });

  it("edits every definition field with the exact visible revision", () => {
    const existing = automation();
    const edited = {
      ...definition,
      name: "Edited review",
      prompt: "Edited prompt",
      runtimeMode: "approval-required" as const,
      interactionMode: "default" as const,
      worktreePolicy: { kind: "current" as const },
      schedule: { ...definition.schedule, cron: "30 7 * * *", timeZone: "Europe/Paris" },
    };
    expect(
      buildAutomationSaveCommand({
        automationId: AUTOMATION_ID,
        definition: edited,
        existing,
        commandId: COMMAND_ID,
        now: NOW,
      }),
    ).toEqual({
      type: "scheduledAutomation.update",
      commandId: COMMAND_ID,
      automationId: AUTOMATION_ID,
      expectedRevision: 4,
      definition: edited,
      createdAt: NOW,
    });
  });

  it("uses the server row identity for updates even when the caller supplies another ID", () => {
    expect(
      buildAutomationSaveCommand({
        automationId: ScheduledAutomationId.make("different-row"),
        definition,
        existing: automation(),
        commandId: COMMAND_ID,
        now: NOW,
      }),
    ).toMatchObject({
      type: "scheduledAutomation.update",
      automationId: AUTOMATION_ID,
      expectedRevision: 4,
    });
  });

  it("disables without carrying or changing linked-thread state", () => {
    const existing = automation({ enabled: true });
    const command = buildAutomationRevisionCommand(existing, "disable", NOW);
    expect(command).toMatchObject({
      type: "scheduledAutomation.enabled.set",
      automationId: AUTOMATION_ID,
      expectedRevision: 4,
      enabled: false,
    });
    expect(command).not.toHaveProperty("lastThreadId");
    expect(existing.lastThreadId).toBe(ThreadId.make("thread-existing"));
  });

  it("binds abandonment to the visible revision", () => {
    const stale = automation();
    expect(buildAutomationRevisionCommand(stale, "abandon", NOW)).toMatchObject({
      type: "scheduledAutomation.failed.abandon",
      automationId: AUTOMATION_ID,
      expectedRevision: 4,
    });
    const current = automation({ revision: 5 });
    expect(
      reconcileAutomationCommandFailure({
        _tag: "ScheduledAutomationConflictError",
        current,
      }),
    ).toMatchObject({ kind: "conflict", current, shouldRetry: false });
  });
});

describe("AutomationsSettings live form rules", () => {
  it("only preserves option combinations present in the selected model descriptor", () => {
    const sol = liveModelSelection(providers, {
      instanceId: CODEX_ID,
      model: "gpt-5.6-sol",
      options: [
        { id: "effort", value: "medium" },
        { id: "unknown", value: "secret" },
        { id: "fastMode", value: true },
      ],
    });
    expect(sol?.options).toEqual([
      { id: "effort", value: "high" },
      { id: "fastMode", value: true },
    ]);

    const terraDescriptors = providers[0]!.models[1]!.capabilities!.optionDescriptors!;
    expect(normalizeProviderOptions(terraDescriptors, sol?.options)).toEqual([
      { id: "effort", value: "medium" },
    ]);
  });

  it("clears stale branch and retains a still-live model on project change", () => {
    const nextProject = {
      id: ProjectId.make("project-two"),
      title: "Project two",
      workspaceRoot: "/workspace/two",
      repositoryIdentity: null,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("missing-provider"),
        model: "missing-model",
      },
    };
    const changed = changeAutomationProject(definition, nextProject, providers);
    expect(changed.projectId).toBe(nextProject.id);
    expect(changed.worktreePolicy).toEqual({
      kind: "new-worktree",
      baseBranch: "",
      startFromOrigin: true,
    });
    expect(changed.modelSelection).toEqual(definition.modelSelection);
  });

  it("clears a stale model when neither it nor the new project default is live", () => {
    const changed = changeAutomationProject(
      {
        ...definition,
        modelSelection: {
          instanceId: ProviderInstanceId.make("missing-provider"),
          model: "missing-model",
        },
      },
      {
        id: ProjectId.make("project-two"),
        title: "Project two",
        workspaceRoot: "/workspace/two",
        repositoryIdentity: null,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("also-missing"),
          model: "missing-default",
        },
      },
      providers,
    );
    expect(changed.modelSelection.model).toBe("");
    expect(changed.worktreePolicy).toMatchObject({ kind: "new-worktree", baseBranch: "" });
  });

  it("matches server provider eligibility for warning and uninstalled states", () => {
    expect(isScheduledAutomationProviderEligible({ ...providers[0]!, status: "warning" })).toBe(
      true,
    );
    expect(isScheduledAutomationProviderEligible({ ...providers[0]!, installed: false })).toBe(
      false,
    );
    expect(
      isScheduledAutomationProviderEligible({
        ...providers[0]!,
        availability: "unavailable",
      }),
    ).toBe(false);
    expect(isScheduledAutomationProviderEligible({ ...providers[0]!, status: "error" })).toBe(
      false,
    );
  });

  it("allows disabled rows to preserve temporarily unavailable locked selections", () => {
    const existing = automation({
      projectId: ProjectId.make("missing-project"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("missing-provider"),
        model: "missing-model",
      },
      worktreePolicy: { kind: "new-worktree", baseBranch: "archived", startFromOrigin: true },
    });
    const draft = { ...automationDraftFromRow(existing), name: "Edited while unavailable" };
    expect(
      canSubmitAutomationDraft({
        automationId: existing.id,
        draft,
        existing,
        projectAvailable: false,
        modelLive: false,
        worktreeAvailable: false,
      }),
    ).toBe(true);
    expect(
      canSubmitAutomationDraft({
        automationId: existing.id,
        draft: { ...draft, modelSelection: definition.modelSelection },
        existing,
        projectAvailable: false,
        modelLive: false,
        worktreeAvailable: false,
      }),
    ).toBe(false);
  });

  it("validates automation IDs as ASCII with the server-compatible pattern", () => {
    expect(isValidAutomationId("weekday-review.2")).toBe(true);
    expect(isValidAutomationId("_weekday")).toBe(false);
    expect(isValidAutomationId("Kelvin")).toBe(false);
  });

  it("maps server cron and timezone validation errors to their exact controls", () => {
    expect(
      reconcileAutomationCommandFailure({
        _tag: "ScheduledAutomationValidationError",
        field: "schedule.cron",
        message: "Cron must contain exactly five fields.",
      }),
    ).toEqual({
      kind: "validation",
      errors: { "schedule.cron": "Cron must contain exactly five fields." },
      shouldRetry: false,
    });
    expect(
      reconcileAutomationCommandFailure({
        _tag: "ScheduledAutomationValidationError",
        field: "schedule.timeZone",
        message: "Use an IANA timezone.",
      }),
    ).toMatchObject({ errors: { "schedule.timeZone": "Use an IANA timezone." } });
    expect(
      renderToStaticMarkup(
        <AutomationFieldError
          errors={{ "schedule.cron": "Cron must contain exactly five fields." }}
          field="schedule.cron"
        />,
      ),
    ).toContain("Cron must contain exactly five fields.");
  });

  it("replaces a stale draft with the server row and never requests an automatic retry", () => {
    const current = automation({ revision: 7, name: "Changed elsewhere" });
    const failure = reconcileAutomationCommandFailure({
      _tag: "ScheduledAutomationConflictError",
      current,
    });
    expect(failure).toMatchObject({
      kind: "conflict",
      current,
      shouldRetry: false,
    });
    expect(failure.kind === "conflict" ? failure.message : "").toContain(
      "review it before trying again",
    );
    if (failure.kind !== "conflict") throw new Error("Expected a conflict fixture.");
    expect(
      buildAutomationSaveCommand({
        automationId: current.id,
        definition: automationDraftFromRow(current),
        existing: failure.current,
        commandId: COMMAND_ID,
        now: NOW,
      }),
    ).toMatchObject({ expectedRevision: 7 });
    const staleView = {
      automation: automation(),
      status: "failed" as const,
      nextScheduledFor: null,
      lastThread: null,
    };
    expect(
      applyAutomationConflictRows([staleView], new Map([[current.id, current]]))[0]?.automation,
    ).toBe(current);
  });

  it("uses durable retry truth and gates abandonment and deletion", () => {
    expect(canRetryAutomation(automation())).toBe(true);
    expect(canRetryAutomation(automation({ lastOutcome: null }))).toBe(false);
    for (const code of [
      SCHEDULED_AUTOMATION_ABANDONED_CODE,
      SCHEDULED_AUTOMATION_BOOTSTRAP_PHASE_REJECTED_CODE,
    ]) {
      const legacyOutcome = decodeOutcome({
        kind: "failed",
        scheduledFor: "2026-08-03T13:00:00.000Z",
        observedAt: "2026-08-03T13:00:01.000Z",
        coalescedCount: 0,
        code,
        detail: "Legacy non-retryable failure.",
      });
      expect(legacyOutcome.kind).toBe("failed");
      expect(
        canRetryAutomation(
          automation({
            lastOutcome: legacyOutcome,
          }),
        ),
      ).toBe(false);
    }
    expect(canDeleteAutomation(automation())).toBe(true);
    expect(canDeleteAutomation(automation({ enabled: true }))).toBe(false);
    expect(canAbandonAutomation(automation())).toBe(true);
    expect(canAbandonAutomation(automation({ enabled: true }))).toBe(false);
    expect(canAbandonAutomation(automation({ lastOutcome: null }))).toBe(false);
    expect(
      canAbandonAutomation(
        automation({
          lastOutcome: {
            kind: "failed",
            scheduledFor: "2026-08-03T13:00:00.000Z",
            observedAt: "2026-08-03T13:00:01.000Z",
            coalescedCount: 0,
            code: SCHEDULED_AUTOMATION_ABANDONED_CODE,
            detail: "Abandoned.",
            retryable: false,
          },
        }),
      ),
    ).toBe(false);
  });

  it("uses explicit isolation, retention, disable, and deletion disclosures", () => {
    expect(CURRENT_WORKSPACE_DISCLOSURE).toContain("not isolated");
    expect(NEW_WORKTREE_DISCLOSURE).toContain("retention cleanup");
    expect(DISABLE_AUTOMATION_DISCLOSURE).toContain("does not interrupt");
    expect(DELETE_AUTOMATION_DISCLOSURE).toContain("worktrees are not deleted");
    expect(ABANDON_AUTOMATION_DISCLOSURE).toContain("thread, branch, and worktree are retained");
  });
});
