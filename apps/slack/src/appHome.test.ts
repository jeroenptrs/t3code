import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

import {
  buildAppHomeView,
  makeAppHomePublisher,
  resolveAppHomeOpenSnapshot,
  selectAppHomeTasks,
  SLACK_HOME_MAX_BLOCKS,
  type AppHomeView,
} from "./appHome.ts";

const NOW = "2026-08-02T12:00:00.000Z";
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
};

const project = (id: string, title = id): OrchestrationProjectShell =>
  ({
    id: ProjectId.make(id),
    title,
    workspaceRoot: `/workspace/${id}`,
    defaultModelSelection: modelSelection,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  }) as OrchestrationProjectShell;

const thread = (input: {
  readonly id: string;
  readonly projectId?: string;
  readonly title?: string;
  readonly createdAt?: string;
  readonly archivedAt?: string | null;
  readonly settledOverride?: "settled" | "active" | null;
  readonly snoozedUntil?: string | null;
  readonly snoozedAt?: string | null;
  readonly sessionStatus?: "starting" | "running" | "stopped" | "error";
  readonly pendingApproval?: boolean;
  readonly pendingInput?: boolean;
  readonly actionablePlan?: boolean;
  readonly interactionMode?: "default" | "plan";
  readonly latestTurnSettled?: boolean;
}): OrchestrationThreadShell =>
  ({
    id: ThreadId.make(input.id),
    projectId: ProjectId.make(input.projectId ?? "project-a"),
    title: input.title ?? input.id,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: input.interactionMode ?? "default",
    branch: null,
    worktreePath: null,
    latestTurn: input.latestTurnSettled
      ? { turnId: "turn-1", startedAt: NOW, completedAt: NOW }
      : null,
    createdAt: input.createdAt ?? NOW,
    updatedAt: input.createdAt ?? NOW,
    archivedAt: input.archivedAt ?? null,
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledOverride === "settled" ? NOW : null,
    snoozedUntil: input.snoozedUntil ?? null,
    snoozedAt: input.snoozedAt ?? null,
    session: input.sessionStatus ? { status: input.sessionStatus, updatedAt: NOW } : null,
    latestUserMessageAt: input.createdAt ?? NOW,
    hasPendingApprovals: input.pendingApproval ?? false,
    hasPendingUserInput: input.pendingInput ?? false,
    hasActionableProposedPlan: input.actionablePlan ?? false,
  }) as OrchestrationThreadShell;

const snapshot = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
  projects: ReadonlyArray<OrchestrationProjectShell> = [
    project("project-a", "Project A"),
    project("project-b", "Project B"),
  ],
  sequence = 1,
): OrchestrationShellSnapshot =>
  ({ snapshotSequence: sequence, projects, threads, updatedAt: NOW }) as OrchestrationShellSnapshot;

afterEach(() => {
  vi.useRealTimers();
});

describe("App Home task selection", () => {
  it("temporarily omits settled work without pending approval or input blockers", () => {
    const selected = selectAppHomeTasks(
      snapshot([
        thread({ id: "older", createdAt: "2026-08-02T09:00:00.000Z" }),
        thread({
          id: "newer",
          projectId: "project-b",
          createdAt: "2026-08-02T11:00:00.000Z",
          pendingInput: true,
        }),
        thread({ id: "settled", settledOverride: "settled" }),
        thread({ id: "archived", archivedAt: NOW }),
        thread({
          id: "snoozed",
          snoozedAt: "2026-08-02T10:00:00.000Z",
          snoozedUntil: "2026-08-03T12:00:00.000Z",
        }),
        thread({ id: "missing-project", projectId: "deleted-project" }),
      ]),
      { now: NOW },
    );

    expect(selected.tasks.map((task) => task.thread.id)).toEqual(["newer", "older"]);
    expect(selected.tasks.map((task) => task.project.title)).toEqual(["Project B", "Project A"]);
    expect(selected.tasks[0]?.status).toBe("Awaiting input");
    expect(selected.nextSnoozeWakeAt).toBe("2026-08-03T12:00:00.000Z");
  });

  it("uses deterministic IDs to break equal or malformed creation-time ties", () => {
    const selected = selectAppHomeTasks(
      snapshot([
        thread({ id: "b", createdAt: "not-a-date" }),
        thread({ id: "a", createdAt: "also-not-a-date" }),
        thread({ id: "A", createdAt: "still-not-a-date" }),
      ]),
      { now: NOW },
    );
    expect(selected.tasks.map((task) => task.thread.id)).toEqual(["A", "a", "b"]);
  });

  it("applies the full status precedence when states collide", () => {
    const selected = selectAppHomeTasks(
      snapshot([
        thread({ id: "input-over-work", pendingInput: true, sessionStatus: "running" }),
        thread({
          id: "connecting-over-plan",
          sessionStatus: "starting",
          interactionMode: "plan",
          latestTurnSettled: true,
          actionablePlan: true,
        }),
        thread({
          id: "failure-over-plan",
          sessionStatus: "error",
          interactionMode: "plan",
          latestTurnSettled: true,
          actionablePlan: true,
        }),
      ]),
      { now: NOW },
    );

    expect(Object.fromEntries(selected.tasks.map((task) => [task.thread.id, task.status]))).toEqual(
      {
        "connecting-over-plan": "Connecting",
        "failure-over-plan": "Failed",
        "input-over-work": "Awaiting input",
      },
    );
  });

  it.each([
    [thread({ id: "approval", pendingApproval: true }), "Pending approval"],
    [thread({ id: "input", pendingInput: true }), "Awaiting input"],
    [thread({ id: "connecting", sessionStatus: "starting" }), "Connecting"],
    [thread({ id: "working", sessionStatus: "running" }), "Working"],
    [thread({ id: "failed", sessionStatus: "error" }), "Failed"],
    [
      thread({
        id: "plan",
        interactionMode: "plan",
        latestTurnSettled: true,
        actionablePlan: true,
      }),
      "Plan ready",
    ],
    [thread({ id: "unsettled-plan", interactionMode: "plan", actionablePlan: true }), "Ready"],
    [thread({ id: "active" }), "Ready"],
  ])("projects task status", (candidate, expected) => {
    expect(selectAppHomeTasks(snapshot([candidate]), { now: NOW }).tasks[0]?.status).toBe(expected);
  });

  it("keeps pending approval or input blockers visible despite a settled override", () => {
    const selected = selectAppHomeTasks(
      snapshot([
        thread({ id: "approval", settledOverride: "settled", pendingApproval: true }),
        thread({ id: "input", settledOverride: "settled", pendingInput: true }),
        thread({
          id: "collision",
          pendingApproval: true,
          sessionStatus: "running",
          interactionMode: "plan",
          latestTurnSettled: true,
          actionablePlan: true,
        }),
      ]),
      { now: NOW },
    );

    expect(selected.tasks.map((task) => task.thread.id)).toEqual([
      "approval",
      "collision",
      "input",
    ]);
    expect(selected.tasks.find((task) => task.thread.id === "collision")?.status).toBe(
      "Pending approval",
    );
  });
});

describe("App Home Block Kit rendering", () => {
  it("shows an active automation thread with its title and ordinary deep link", () => {
    const tasks = selectAppHomeTasks(
      snapshot([
        thread({
          id: "t3sa:v1:automation:occurrence:thread",
          title: "Automation: Nightly maintenance",
          sessionStatus: "running",
        }),
      ]),
      { now: NOW },
    ).tasks;
    const rendered = JSON.stringify(
      buildAppHomeView({
        tasks,
        publicBaseUrl: "https://t3.example",
        environmentId: "environment-a",
      }),
    );

    expect(tasks).toHaveLength(1);
    expect(rendered).toContain("Automation: Nightly maintenance");
    expect(rendered).toContain("/t3sa%3Av1%3Aautomation%3Aoccurrence%3Athread");
  });

  it("renders direct task links with status and project plus the environment-level header link", () => {
    const tasks = selectAppHomeTasks(
      snapshot([
        thread({ id: "thread/value", title: "Fix <render> | safely", pendingApproval: true }),
      ]),
      { now: NOW },
    ).tasks;
    const view = buildAppHomeView({
      tasks,
      publicBaseUrl: "https://t3.example/root/?ignored=true#ignored",
      environmentId: "environment/value",
    });
    const text = JSON.stringify(view);

    expect(text).toContain("https://t3.example/root/environment%2Fvalue");
    expect(text).toContain("/thread%2Fvalue");
    expect(text).toContain("Fix &lt;render&gt; ¦ safely");
    expect(text).toContain("Welcome to T3 Code");
    expect(text).toContain("View all tasks");
    expect(text).toContain("*Active conversations*");
    expect(text).toContain("Status: *Pending approval*    Project: *Project A*");
    expect(text).not.toContain("Pending approval · Project A");
  });

  it("uses the full Home-tab block budget and adds an environment-root footer only on overflow", () => {
    const tasks = selectAppHomeTasks(
      snapshot(
        Array.from({ length: 100 }, (_, index) =>
          thread({
            id: `thread-${index}`,
            createdAt: new Date(Date.parse(NOW) - index).toISOString(),
          }),
        ),
      ),
      { now: NOW },
    ).tasks;
    const view = buildAppHomeView({
      tasks,
      publicBaseUrl: "https://t3.example",
      environmentId: "environment-a",
    });

    expect(view.blocks).toHaveLength(SLACK_HOME_MAX_BLOCKS);
    expect(JSON.stringify(view.blocks.at(-1))).toContain("newest 94 of 100");
    expect(JSON.stringify(view.blocks.at(-1))).toContain(
      "https://t3.example/environment-a|View all in T3 Code",
    );

    const exactFit = buildAppHomeView({
      tasks: tasks.slice(0, 95),
      publicBaseUrl: "https://t3.example",
      environmentId: "environment-a",
    });
    expect(exactFit.blocks).toHaveLength(SLACK_HOME_MAX_BLOCKS);
    expect(JSON.stringify(exactFit)).not.toContain("View all in T3 Code");
  });

  it("renders an empty state without a truncation footer", () => {
    const view = buildAppHomeView({
      tasks: [],
      publicBaseUrl: "https://t3.example",
      environmentId: "environment-a",
    });
    expect(view.blocks).toHaveLength(6);
    expect(JSON.stringify(view)).toContain("No active conversations");
    expect(JSON.stringify(view)).not.toContain("View all in T3 Code");
  });

  it("bounds titles by Unicode characters without splitting a surrogate pair", () => {
    const title = `${"a".repeat(176)}😀${"b".repeat(20)}`;
    const tasks = selectAppHomeTasks(snapshot([thread({ id: "unicode", title })]), {
      now: NOW,
    }).tasks;
    const view = buildAppHomeView({
      tasks,
      publicBaseUrl: "https://t3.example",
      environmentId: "environment-a",
    });

    expect(JSON.stringify(view)).toContain(`${"a".repeat(176)}😀...`);
  });
});

describe("App Home publication", () => {
  it("attempts an HTTP refresh on every open and re-reads the accepted projection", async () => {
    let current = snapshot([thread({ id: "before-refresh" })], undefined, 1);
    const refreshed = snapshot([thread({ id: "after-refresh" })], undefined, 2);
    const refresh = vi.fn(async () => {
      current = refreshed;
    });

    await expect(
      resolveAppHomeOpenSnapshot({
        getSnapshot: () => current,
        refresh,
      }),
    ).resolves.toBe(refreshed);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps a live snapshot that arrives while an open-time refresh fails", async () => {
    let current: OrchestrationShellSnapshot | null = null;
    let rejectRefresh!: (error: Error) => void;
    const refresh = new Promise<void>((_resolve, reject) => (rejectRefresh = reject));
    const errors: unknown[] = [];

    const resolving = resolveAppHomeOpenSnapshot({
      getSnapshot: () => current,
      refresh: () => refresh,
      onRefreshError: (error) => errors.push(error),
    });
    current = snapshot([thread({ id: "live" })], undefined, 2);
    rejectRefresh(new Error("offline"));

    await expect(resolving).resolves.toBe(current);
    expect(errors).toHaveLength(1);
  });

  it("publishes every open, skips unchanged live content, and debounces changed content", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const publications: Array<{ readonly userId: string; readonly view: AppHomeView }> = [];
    const publisher = makeAppHomePublisher({
      publicBaseUrl: "https://t3.example",
      resolveEnvironmentId: async () => "environment-a",
      publish: async (userId, view) => {
        publications.push({ userId, view });
      },
      debounceMs: 20,
    });
    const initial = snapshot([thread({ id: "initial" })]);

    await publisher.opened("U1", initial);
    await publisher.opened("U1", initial);
    publisher.updated(initial);
    await vi.advanceTimersByTimeAsync(20);
    expect(publications).toHaveLength(2);

    publisher.updated(snapshot([thread({ id: "new" }), thread({ id: "initial" })]));
    publisher.updated(snapshot([thread({ id: "new" }), thread({ id: "initial" })]));
    await vi.advanceTimersByTimeAsync(20);
    expect(publications).toHaveLength(3);
    expect(publications.at(-1)?.userId).toBe("U1");
    await publisher.stop();
  });

  it("isolates one user's Slack failure from other observed users", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const successful: string[] = [];
    const failures: Array<string | null> = [];
    const publisher = makeAppHomePublisher({
      publicBaseUrl: "https://t3.example",
      resolveEnvironmentId: async () => "environment-a",
      publish: async (userId) => {
        if (userId === "U-failing") throw new Error("Slack rejected the view");
        successful.push(userId);
      },
      debounceMs: 10,
      onError: (_error, userId) => failures.push(userId),
    });
    const initial = snapshot([thread({ id: "initial" })]);
    await publisher.opened("U-failing", initial);
    await publisher.opened("U-working", initial);

    publisher.updated(snapshot([thread({ id: "changed" })]));
    await vi.advanceTimersByTimeAsync(10);

    expect(successful).toEqual(["U-working", "U-working"]);
    expect(failures).toEqual(["U-failing", "U-failing"]);
    await publisher.stop();
  });

  it("republishes when a snoozed task wakes without a shell event and cancels timers on stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const publications: AppHomeView[] = [];
    const publisher = makeAppHomePublisher({
      publicBaseUrl: "https://t3.example",
      resolveEnvironmentId: async () => "environment-a",
      publish: async (_userId, view) => {
        publications.push(view);
      },
      debounceMs: 20,
    });
    const snoozed = snapshot([
      thread({
        id: "wakes-soon",
        snoozedAt: "2026-08-02T11:00:00.000Z",
        snoozedUntil: "2026-08-02T12:00:01.000Z",
      }),
    ]);

    await publisher.opened("U1", snoozed);
    expect(JSON.stringify(publications[0])).toContain("No active conversations");
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.advanceTimersByTimeAsync(20);
    expect(publications).toHaveLength(2);
    expect(JSON.stringify(publications[1])).toContain("wakes-soon");

    publisher.updated(snapshot([thread({ id: "not-published-after-stop" })]));
    await publisher.stop();
    await vi.runAllTimersAsync();
    expect(publications).toHaveLength(2);
  });

  it("still publishes a fresh unavailable view when T3 has no snapshot", async () => {
    const publications: AppHomeView[] = [];
    const publisher = makeAppHomePublisher({
      publicBaseUrl: "https://t3.example",
      resolveEnvironmentId: async () => {
        throw new Error("offline");
      },
      publish: async (_userId, view) => {
        publications.push(view);
      },
    });

    await publisher.opened("U1", null);
    expect(publications).toHaveLength(1);
    expect(JSON.stringify(publications[0])).toContain("temporarily unavailable");
    expect(JSON.stringify(publications[0])).toContain('"url":"https://t3.example"');
    await publisher.stop();
  });

  it("serializes a user's publications and coalesces queued work onto the newest snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const started: string[] = [];
    const applied: string[] = [];
    const releases: Array<() => void> = [];
    const publisher = makeAppHomePublisher({
      publicBaseUrl: "https://t3.example",
      resolveEnvironmentId: async () => "environment-a",
      publish: async (_userId, view) => {
        const rendered = JSON.stringify(view);
        const title = ["newest", "middle", "oldest"].find((candidate) =>
          rendered.includes(candidate),
        );
        if (!title) throw new Error("expected a rendered task title");
        started.push(title);
        await new Promise<void>((resolve) => releases.push(resolve));
        applied.push(title);
      },
      debounceMs: 10,
    });

    const firstOpen = publisher.opened("U1", snapshot([thread({ id: "oldest" })], undefined, 1));
    await vi.waitFor(() => expect(started).toEqual(["oldest"]));

    publisher.updated(snapshot([thread({ id: "newest" })], undefined, 3));
    await vi.advanceTimersByTimeAsync(10);
    const staleOpen = publisher.opened("U1", snapshot([thread({ id: "middle" })], undefined, 2));
    expect(started).toEqual(["oldest"]);

    releases.shift()?.();
    await vi.waitFor(() => expect(started).toEqual(["oldest", "newest"]));
    releases.shift()?.();
    await vi.waitFor(() => expect(started).toEqual(["oldest", "newest", "newest"]));
    releases.shift()?.();
    await Promise.all([firstOpen, staleOpen]);

    expect(applied).toEqual(["oldest", "newest", "newest"]);
    publisher.updated(snapshot([thread({ id: "newest" })], undefined, 3));
    await vi.advanceTimersByTimeAsync(10);
    expect(started).toEqual(["oldest", "newest", "newest"]);
    await publisher.stop();
  });

  it("starts live publications for different users independently", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const started: string[] = [];
    let releaseSlow!: () => void;
    let holdSlow = false;
    let nowCalls = 0;
    const publisher = makeAppHomePublisher({
      publicBaseUrl: "https://t3.example",
      resolveEnvironmentId: async () => "environment-a",
      publish: async (userId) => {
        started.push(userId);
        if (holdSlow && userId === "U-slow") {
          await new Promise<void>((resolve) => (releaseSlow = resolve));
        }
      },
      debounceMs: 10,
      now: () => {
        nowCalls += 1;
        return new Date(NOW);
      },
    });
    const initial = snapshot([thread({ id: "initial" })]);
    await publisher.opened("U-slow", initial);
    await publisher.opened("U-fast", initial);
    started.length = 0;
    nowCalls = 0;
    holdSlow = true;

    publisher.updated(snapshot([thread({ id: "changed" })], undefined, 2));
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(started).toEqual(["U-slow", "U-fast"]));
    expect(nowCalls).toBe(2);

    releaseSlow();
    await publisher.stop();
  });

  it("waits for a publication already in progress during teardown", async () => {
    let release!: () => void;
    let started!: () => void;
    const publicationStarted = new Promise<void>((resolve) => (started = resolve));
    const publisher = makeAppHomePublisher({
      publicBaseUrl: "https://t3.example",
      resolveEnvironmentId: async () => "environment-a",
      publish: async () => {
        started();
        await new Promise<void>((resolve) => (release = resolve));
      },
    });
    const opening = publisher.opened("U1", snapshot([thread({ id: "initial" })]));
    await publicationStarted;

    let stopped = false;
    const stopping = publisher.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release();
    await Promise.all([opening, stopping]);
    expect(stopped).toBe(true);
  });
});
