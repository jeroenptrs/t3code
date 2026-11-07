import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerConfig,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
} from "@t3tools/contracts";
import {
  DEFAULT_TRIGGER_PROMPT,
  parseTriageDraft,
} from "@t3tools/client-runtime/scheduled-task-trigger";
import {
  scheduledTaskDefaultModel,
  createDraft,
  DEFAULT_SCHEDULE,
  editDraft,
  hasScheduledTaskDraftChanges,
  scheduleDraftForTask,
  scheduleFromDraft,
  switchScheduleMode,
} from "./scheduledTaskDraft";

describe("scheduleDraftForTask", () => {
  it("opens legacy sub-minute schedules at the writable minimum", () => {
    const draft = scheduleDraftForTask({ schedule: { type: "interval", everyMs: 30_000 } });
    expect(draft.intervalMinutes).toBe("1");
    expect(scheduleFromDraft(draft)).toEqual({ type: "interval", everyMs: 60_000 });
  });

  it("round-trips dedupe settings and rejects invalid windows", () => {
    const dedupe = {
      replayKey: "{{headers.delivery-id}}",
      coalesceKey: "{{body.id}}",
      coalesceWindowSeconds: 3600,
    };
    const draft = scheduleDraftForTask({ schedule: { type: "webhook", signature: null, dedupe } });
    expect(scheduleFromDraft(draft)).toMatchObject({ dedupe });
    expect(
      scheduleFromDraft({
        ...draft,
        replayKey: " \n ",
        coalesceKey: " \t ",
        coalesceWindowSeconds: "",
      }),
    ).toMatchObject({ dedupe: {} });
    expect(
      scheduleFromDraft({
        ...draft,
        replayKey: `  ${dedupe.replayKey}  `,
        coalesceKey: `\t${dedupe.coalesceKey}\n`,
      }),
    ).toMatchObject({ dedupe });
    expect(
      scheduleFromDraft({ ...draft, replayKey: "", coalesceKey: "", coalesceWindowSeconds: "" }),
    ).toMatchObject({ dedupe: {} });
    for (const coalesceWindowSeconds of ["9", "3601", "1.5", "abc"]) {
      expect(scheduleFromDraft({ ...draft, coalesceWindowSeconds })).toBeNull();
    }
  });

  it("keeps a webhook signature on save without sending a secret", () => {
    const signature = {
      header: "x-hub-signature-256",
      encoding: "hex" as const,
      prefix: "sha256=",
    };
    const saved = scheduleFromDraft(
      scheduleDraftForTask({ schedule: { type: "webhook", signature } }),
    );
    expect(saved).toEqual({ type: "webhook", signature, maxDeliveryAgeMinutes: null, dedupe: {} });
    expect(saved?.type === "webhook" && saved.signature && "secret" in saved.signature).toBe(false);
  });

  it("round-trips webhook filters and refuses an invalid one", () => {
    const filters = [
      { path: "headers.x-github-event", op: "equals", value: "pull_request" },
      { path: "body.label.name", op: "in", value: ["needs review", "agent:fix"] },
    ] as const;
    const draft = scheduleDraftForTask({ schedule: { type: "webhook", signature: null, filters } });
    // Untouched rows are left out, so the server keeps whatever is stored now.
    expect(scheduleFromDraft(draft)).not.toHaveProperty("filters");
    expect(scheduleFromDraft({ ...draft, filters: [] })).toMatchObject({ filters: [] });
    expect(scheduleFromDraft({ ...draft, filters: draft.filters.slice(1) })).toMatchObject({
      filters: filters.slice(1),
    });
    expect(
      scheduleFromDraft({ ...draft, filters: [{ id: "f1", path: "", op: "exists", value: "" }] }),
    ).toBeNull();
  });

  it.each([
    [
      "jira",
      [
        { path: "event.type", op: "equals", value: "issue.status_changed" },
        { path: "event.addedLabels", op: "in", value: ["agent", "triage"] },
      ],
    ],
    ["gitlab", [{ path: "event.checksState", op: "equals", value: "failing" }]],
    ["slack", [{ path: "event.surface", op: "exists" }]],
  ] as const)("round-trips %s filters and sends them only when edited", (type, filters) => {
    const draft = scheduleDraftForTask({ schedule: { type, filters } });
    expect(draft.mode).toBe(type);
    expect(scheduleFromDraft(draft)).toEqual({ type });
    expect(scheduleFromDraft({ ...draft, triggerFilters: [] })).toEqual({ type, filters: [] });
    expect(
      scheduleFromDraft({
        ...draft,
        triggerFilters: draft.triggerFilters.map((row) => ({ ...row, id: `copy-${row.id}` })),
      }),
    ).toEqual({ type });
    expect(
      scheduleFromDraft({
        ...draft,
        triggerFilters: [{ id: "f1", path: "event.notAField", op: "exists", value: "" }],
      }),
    ).toBeNull();
    expect(
      scheduleFromDraft({
        ...draft,
        triggerFilters: [{ id: "f1", path: "event.type", op: "in", value: " , " }],
      }),
    ).toBeNull();
  });

  it("opens a manual task and saves it as manual", () => {
    const draft = scheduleDraftForTask({ schedule: { type: "manual" } });
    expect(draft.mode).toBe("manual");
    expect(scheduleFromDraft(draft)).toEqual({ type: "manual" });
  });
});

describe("switchScheduleMode", () => {
  it("fills the source's default prompt only on a new task without a prompt of its own", () => {
    const jira = switchScheduleMode(createDraft(null, null), "jira", 0);
    expect(jira.prompt).toBe(DEFAULT_TRIGGER_PROMPT.jira);
    expect(switchScheduleMode(jira, "gitlab", 0).prompt).toBe(DEFAULT_TRIGGER_PROMPT.gitlab);
    expect(
      switchScheduleMode({ ...createDraft(null, null), prompt: "Mine" }, "jira", 0).prompt,
    ).toBe("Mine");
  });

  it("starts filters over on a source switch and restores the saved ones", () => {
    const filters = [{ path: "event.status", op: "equals", value: "In Progress" }] as const;
    const saved = editDraft({
      id: "task",
      title: "Task",
      prompt: "Work",
      schedule: { type: "jira", filters },
      workspaceStrategy: { type: "root" },
    } as unknown as Parameters<typeof editDraft>[0]);
    const gitlab = switchScheduleMode(saved, "gitlab", 0);
    expect(gitlab.prompt).toBe("Work");
    expect(gitlab.schedule.triggerFilters).toEqual([]);
    expect(scheduleFromDraft(gitlab.schedule)).toEqual({ type: "gitlab" });
    const back = switchScheduleMode(gitlab, "jira", 0);
    expect(scheduleFromDraft(back.schedule)).toEqual({ type: "jira" });
    expect(scheduleFromDraft({ ...back.schedule, triggerFilters: [] })).toEqual({
      type: "jira",
      filters: [],
    });
  });
});

describe("triage", () => {
  it("opens a task's triage, sends it only when changed, and counts the change", () => {
    const saved = editDraft({
      id: "task",
      title: "Task",
      prompt: "Work",
      schedule: { type: "jira" },
      workspaceStrategy: { type: "root" },
      triage: { fallback: "label", label: "needs-triage" },
    } as unknown as Parameters<typeof editDraft>[0]);
    expect(parseTriageDraft(saved.triage)).toEqual({});
    const off = { ...saved, triage: { ...saved.triage, fallback: "off" as const } };
    expect(hasScheduledTaskDraftChanges(saved, off)).toBe(true);
    expect(parseTriageDraft(off.triage)).toEqual({ triage: null });
    expect(parseTriageDraft(createDraft(null, null).triage)).toEqual({});
  });
});

describe("scheduleFromDraft", () => {
  const SERVER_TIME_SCHEDULE = { ...DEFAULT_SCHEDULE, timeZone: null };

  it("keeps the schedule's time zone", () => {
    expect(scheduleFromDraft({ ...SERVER_TIME_SCHEDULE, timeZone: "Europe/Amsterdam" })).toEqual({
      type: "fixed_time",
      timeOfDay: "09:00",
      timeZone: "Europe/Amsterdam",
      weekdays: [1, 2, 3, 4, 5],
    });
  });

  it("rejects an empty day selection rather than silently scheduling every day", () => {
    expect(scheduleFromDraft({ ...SERVER_TIME_SCHEDULE, weekdays: [] })).toBeNull();
  });

  it.each([
    ["1.5", 90_000],
    ["2,5", 150_000],
    [" 2,5 ", 150_000],
    [String(60_001 / 60_000), 60_001],
  ])("preserves a valid %s minute interval when saving", (intervalMinutes, everyMs) => {
    expect(
      scheduleFromDraft({ ...SERVER_TIME_SCHEDULE, mode: "interval", intervalMinutes }),
    ).toEqual({
      type: "interval",
      everyMs,
    });
  });

  it("round-trips a Jira query, keeps a saved filter set on web, and refuses short intervals", () => {
    const jql = scheduleDraftForTask({
      schedule: { type: "jira_query", site: "acme.atlassian.net", jql: "x", everyMs: 900_000 },
    });
    expect(jql).toMatchObject({ mode: "jira_query", jiraPollMinutes: "15" });
    expect(scheduleFromDraft({ ...jql, jql: " labels = agent " })).toEqual({
      type: "jira_query",
      site: "acme.atlassian.net",
      jql: "labels = agent",
      everyMs: 900_000,
    });
    expect(scheduleFromDraft({ ...jql, jiraPollMinutes: "4" })).toBeNull();
    expect(scheduleFromDraft({ ...jql, jiraPollMinutes: "5.5" })).toBeNull();
    const saved = scheduleDraftForTask({
      schedule: { type: "jira_query", site: "acme.atlassian.net", filterId: "7", everyMs: 300_000 },
    });
    expect(scheduleFromDraft(saved)).toEqual({
      type: "jira_query",
      site: "acme.atlassian.net",
      filterId: "7",
      everyMs: 300_000,
    });
  });

  it("round-trips GitLab projects, one path per line, and refuses an empty scope", () => {
    const draft = scheduleDraftForTask({
      schedule: {
        type: "gitlab_projects",
        host: "gitlab.acme.dev",
        projects: ["acme/app", "acme/api"],
        everyMs: 900_000,
      },
    });
    expect(draft).toMatchObject({ mode: "gitlab_projects", gitlabProjects: "acme/app\nacme/api" });
    expect(scheduleFromDraft({ ...draft, gitlabProjects: "", gitlabGroup: " acme " })).toEqual({
      type: "gitlab_projects",
      host: "gitlab.acme.dev",
      projects: [],
      group: "acme",
      everyMs: 900_000,
    });
    expect(scheduleFromDraft({ ...draft, gitlabProjects: " \n" })).toBeNull();
    expect(scheduleFromDraft({ ...draft, gitlabPollMinutes: "4" })).toBeNull();
  });

  it.each(["0,5", "2,5,0", "Infinity", "150119987580", ""])(
    "rejects invalid interval minutes: %s",
    (intervalMinutes) => {
      expect(
        scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes }),
      ).toBeNull();
    },
  );
});

describe("scheduled task model defaults", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const projectId = ProjectId.make("project");
  const environmentSelection = {
    instanceId,
    model: "environment-model",
    options: [{ id: "reasoning", value: "high" }],
  };
  const projectSelection = { instanceId, model: "project-model" };
  const config = {
    settings: { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: environmentSelection },
    providers: [
      {
        instanceId,
        driver: "codex",
        displayName: "Codex",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [
          { slug: "first-model", name: "First", isCustom: false, capabilities: null },
          {
            slug: "catalog-default",
            name: "Default",
            isDefault: true,
            isCustom: false,
            capabilities: null,
          },
          { slug: "environment-model", name: "Environment", isCustom: false, capabilities: null },
          { slug: "project-model", name: "Project", isCustom: false, capabilities: null },
        ],
      },
    ],
  } as unknown as ServerConfig;
  const resolve = scheduledTaskDefaultModel;
  it("prefers the project's configured model", () => {
    expect(resolve(config, { id: projectId, defaultModelSelection: projectSelection })).toEqual(
      projectSelection,
    );
    expect(
      resolve(
        {
          ...config,
          settings: {
            ...config.settings,
            projectSettingsOverrides: {
              [projectId]: { defaultModelSelection: projectSelection },
            },
          },
        },
        { id: projectId },
      ),
    ).toEqual(projectSelection);
  });
  it("uses the advertised default instead of catalog order when no default is configured", () => {
    expect(
      resolve({ ...config, settings: { ...config.settings, defaultModelSelection: null } }, null),
    ).toEqual({ instanceId, model: "catalog-default" });
  });
  it("falls back to the environment default when the project provider is unavailable", () => {
    expect(
      resolve(config, {
        id: projectId,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("unavailable"),
          model: "missing",
        },
      }),
    ).toEqual(environmentSelection);
  });
  it("does not choose an implicit model on a disabled provider", () => {
    expect(
      resolve(
        {
          ...config,
          settings: {
            ...config.settings,
            providerInstances: {
              [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
            },
          },
          providers: config.providers.map((provider) => ({ ...provider, enabled: false })),
        },
        null,
      ),
    ).toBeNull();
  });
});

it("rejects dedupe keys without valid request placeholders", () => {
  expect(
    scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "webhook", replayKey: "literal" }),
  ).toBeNull();
  expect(
    scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "webhook", coalesceKey: "{{body.bad" }),
  ).toBeNull();
});
