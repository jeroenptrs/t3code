import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadSections, type ThreadSectionsInput } from "./threadSections";

const NOW = "2026-06-02T12:00:00.000Z";
const home = EnvironmentId.make("home");
const office = EnvironmentId.make("office");
const app = ProjectId.make("app");
const docs = ProjectId.make("docs");

function thread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
  environmentId: EnvironmentId = home,
): EnvironmentThreadShell {
  const providerInstanceId = ProviderInstanceId.make("codex");
  const at = DateTime.makeUnsafe("2026-06-02T10:00:00.000Z");
  const raw: OrchestrationV2ThreadShell = {
    id: ThreadId.make(id),
    projectId: overrides.projectId ?? app,
    title: id,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "mobile",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  };
  return { ...presentThreadShell(environmentId, raw), ...overrides };
}

const runtime = (status: "running" | "completed") => ({
  status,
  activeRunId: status === "running" ? RunId.make("run") : null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: null,
  lastError: null,
  updatedAt: "2026-06-02T11:00:00.000Z",
});

const completedRun = {
  runId: RunId.make("run"),
  status: "completed" as const,
  requestedAt: "2026-06-02T11:00:00.000Z",
  startedAt: "2026-06-02T11:00:00.000Z",
  completedAt: "2026-06-02T11:30:00.000Z",
  assistantMessageId: null,
};

function build(overrides: Partial<ThreadSectionsInput> & Pick<ThreadSectionsInput, "threads">) {
  return buildThreadSections({
    environmentId: null,
    projectRefs: null,
    now: NOW,
    settlementEnvironmentIds: new Set([home, office]),
    snoozeEnvironmentIds: new Set([home, office]),
    expanded: { working: true, snoozed: true, settled: true },
    settledLimit: 10,
    ...overrides,
  });
}

function outline(entries: ReturnType<typeof build>["entries"]) {
  return entries.map((entry) =>
    entry.type === "header"
      ? `# ${entry.section} ${entry.count}`
      : entry.type === "more"
        ? `more ${entry.hiddenCount}`
        : `${entry.thread.id}${entry.chip ? ` [${entry.chip.label}:${entry.chip.tone}]` : ""}`,
  );
}

describe("buildThreadSections", () => {
  const threads = [
    thread("idle"),
    thread("running", { runtime: runtime("running") }),
    thread("done", {
      runtime: runtime("completed"),
      latestRun: completedRun,
      lastVisitedAt: "2026-06-02T11:10:00.000Z",
    }),
    thread("snoozed", { snoozedUntil: "2026-06-03T09:00:00.000Z" }),
    thread("settled", { settledOverride: "settled", settledAt: "2026-06-01T10:00:00.000Z" }),
    thread("office-idle", { projectId: docs }, office),
    thread("archived", { archivedAt: "2026-06-01T10:00:00.000Z" }),
  ];

  it("lists threads in mobile's sections with a status colour per state", () => {
    expect(outline(build({ threads }).entries)).toEqual([
      "# active 3",
      "done [Done:done]",
      "idle",
      "office-idle",
      "# working 1",
      "running [Working:working]",
      "# snoozed 1",
      "snoozed",
      "# settled 1",
      "settled",
    ]);
  });

  it("keeps collapsed sections as headers with their counts", () => {
    const { entries } = build({
      threads,
      expanded: { working: false, snoozed: false, settled: false },
    });
    expect(outline(entries).filter((line) => line.startsWith("#"))).toEqual([
      "# active 3",
      "# working 1",
      "# snoozed 1",
      "# settled 1",
    ]);
    expect(outline(entries)).not.toContain("running [Working:working]");
  });

  it("scopes to one environment and to a project", () => {
    expect(outline(build({ threads, environmentId: office }).entries)).toEqual([
      "# active 1",
      "office-idle",
    ]);
    expect(
      outline(build({ threads, projectRefs: [{ environmentId: home, projectId: docs }] }).entries),
    ).toEqual([]);
  });

  it("pages settled threads, counting older ones not loaded yet", () => {
    const settled = Array.from({ length: 3 }, (_, index) =>
      thread(`settled-${index}`, {
        settledOverride: "settled",
        settledAt: `2026-06-01T1${index}:00:00.000Z`,
      }),
    );
    const { entries } = build({ threads: settled, settledLimit: 2, unloadedSettledCount: 5 });
    expect(outline(entries)).toEqual(["# settled 8", "settled-2", "settled-1", "more 6"]);
  });
});
