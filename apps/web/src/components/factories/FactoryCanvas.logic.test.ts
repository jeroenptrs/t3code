import {
  EnvironmentId,
  FactoryId,
  ScheduledTaskId,
  ThreadId,
  WorkItemId,
  type FactoryThread,
  type WorkItemStage,
  type WorkItemSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createFactoryCanvasSelector,
  factoryGraph,
  factoryGraphState,
  type CanvasShell,
  type FactoryCanvasInput,
} from "./FactoryCanvas.logic";

const environmentId = EnvironmentId.make("environment-local");
const factoryId = FactoryId.make("factory:project-api:nightly");
const nightly = ScheduledTaskId.make("task-nightly");
const webhook = ScheduledTaskId.make("task-webhook");
const foreman = ThreadId.make("factory-foreman:1");
const implementer = ThreadId.make("thread-implement");
const reviewer = ThreadId.make("thread-review");
const unrelated = ThreadId.make("thread-unrelated");

const threads: ReadonlyArray<FactoryThread> = [
  { threadId: foreman, role: "foreman" },
  { threadId: implementer, role: "implement" },
  { threadId: reviewer, role: "review" },
];

function shell(id: ThreadId, running: boolean, extra: Partial<CanvasShell> = {}): CanvasShell {
  return {
    environmentId,
    id,
    runtime: running
      ? {
          status: "running",
          activeRunId: null,
          activityStartedAt: undefined,
          providerInstanceId: "codex" as never,
          updatedAt: "2026-11-06T00:00:00.000Z",
        }
      : null,
    branch: null,
    linkedPullRequest: null,
    branchPullRequest: null,
    ...extra,
  } as CanvasShell;
}

function item(
  id: string,
  stage: WorkItemStage,
  extra: Partial<WorkItemSummary> = {},
): WorkItemSummary {
  return {
    id: WorkItemId.make(id),
    factoryId,
    title: `Item ${id}`,
    source: { kind: "manual", text: "" },
    stage,
    gate: { state: "none" },
    foremanThreadId: foreman,
    foremanRunId: null,
    dispatchedAt: null,
    threads: [],
    createdAt: "2026-11-06T00:00:00.000Z",
    updatedAt: "2026-11-06T00:00:00.000Z",
    ...extra,
  } as WorkItemSummary;
}

const definition = {
  scheduledTaskIds: [nightly, webhook],
  scheduledTasks: [{ id: nightly, title: "Nightly triage" }],
};

describe("factoryGraph", () => {
  it("lays the definition out in four layers with spawn edges only", () => {
    const graph = factoryGraph(definition);
    expect(graph.nodes.map((node) => [node.id, node.layer, node.label])).toEqual([
      ["trigger:task-nightly", 0, "Nightly triage"],
      ["trigger:task-webhook", 0, "task-webhook"],
      ["trigger:manual", 0, "Manual"],
      ["foreman", 1, "Foreman"],
      ["implement", 2, "Implement"],
      ["review", 2, "Review"],
      ["gate", 2, "Gate"],
      ["output", 3, "Output"],
    ]);
    expect(graph.nodes).toHaveLength(definition.scheduledTaskIds.length + 6);
    expect(graph.edges.map((edge) => edge.id)).toEqual([
      "trigger:task-nightly->foreman",
      "trigger:task-webhook->foreman",
      "trigger:manual->foreman",
      "foreman->implement",
      "foreman->review",
      "foreman->gate",
      "foreman->output",
    ]);
    const layerX = new Set(graph.nodes.filter((node) => node.layer === 2).map((node) => node.x));
    expect(layerX.size).toBe(1);
    const ys = graph.nodes.filter((node) => node.layer === 0).map((node) => node.y);
    expect(ys[1]! - ys[0]!).toBe(ys[2]! - ys[1]!);
  });
});

describe("factoryGraphState", () => {
  const graph = factoryGraph(definition);
  const state = (shells: ReadonlyArray<CanvasShell>, items: ReadonlyArray<WorkItemSummary>) =>
    factoryGraphState(graph, { environmentId, threads, shells, items });
  const litEdges = (result: ReturnType<typeof state>) =>
    [...result.edges].flatMap(([id, edge]) => (edge.lit ? [[id, edge.title, edge.more]] : []));

  it.each([
    ["queued", []],
    ["new", [["trigger:manual->foreman", "Item 1", 0]]],
    ["implement", [["foreman->implement", "Item 1", 0]]],
    ["review", [["foreman->review", "Item 1", 0]]],
    ["waiting", [["foreman->gate", "Item 1", 0]]],
    ["done", []],
    ["failed", []],
  ] as const)("an item at %s lights %j", (stage, expected) => {
    expect(litEdges(state([], [item("1", stage)]))).toEqual(expected);
  });

  it("lights a scheduled item's own trigger edge and groups items on one edge", () => {
    const result = state(
      [],
      [
        item("1", "new", {
          source: { kind: "scheduled_task", scheduledTaskId: nightly, deliveryId: null, text: "" },
        }),
        item("2", "implement"),
        item("3", "implement"),
      ],
    );
    expect(litEdges(result)).toEqual([
      ["trigger:task-nightly->foreman", "Item 1", 0],
      ["foreman->implement", "Item 2", 1],
    ]);
  });

  it("lights role nodes from owned running threads and the gate from a waiting item", () => {
    const result = state(
      [shell(implementer, true), shell(reviewer, false), shell(unrelated, true)],
      [item("1", "waiting")],
    );
    expect(
      [...result.nodes].flatMap(([id, node]) => (node.lit ? [[id, node.threadId]] : [])),
    ).toEqual([
      ["implement", implementer],
      ["gate", foreman],
    ]);
  });

  it("shows the active item's implement branch, then its pull request, on the output node", () => {
    const active = item("1", "implement", {
      threads: [{ threadId: implementer, role: "implement" }],
    });
    const output = (shells: ReadonlyArray<CanvasShell>) =>
      state(shells, [active]).nodes.get("output")?.detail;
    expect(output([])).toBe("Branch or PR");
    expect(output([shell(implementer, true, { branch: "t3/fix-login" })])).toBe("t3/fix-login");
    expect(
      output([
        shell(implementer, true, {
          branch: "t3/fix-login",
          linkedPullRequest: {
            projectId: "project-api" as never,
            repository: "acme/api",
            number: 12,
            url: "https://github.com/acme/api/pull/12",
          },
        }),
      ]),
    ).toBe("PR #12");
  });
});

describe("createFactoryCanvasSelector", () => {
  it("keeps the previous state when an unrelated thread changes, and moves when an owned one does", () => {
    const select = createFactoryCanvasSelector();
    const items = [item("1", "implement")];
    const input = (shells: ReadonlyArray<CanvasShell>): FactoryCanvasInput => ({
      environmentId,
      ...definition,
      threads,
      items,
      shells,
    });
    const first = select(input([shell(implementer, true), shell(unrelated, false)]));
    expect(select(input([shell(implementer, true), shell(unrelated, true)]))).toBe(first);
    // A refetch that answers the same rows is a new array, not a new state.
    expect(select({ ...input([shell(implementer, true)]), items: [item("1", "implement")] })).toBe(
      first,
    );
    const stopped = select(input([shell(implementer, false)]));
    expect(stopped).not.toBe(first);
    expect(stopped.nodes.get("implement")?.lit).toBe(false);
    expect(stopped.graph).toBe(first.graph);
  });
});
