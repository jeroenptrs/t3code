import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  FactoryRoleName,
  FactoryThread,
  ScheduledTaskId,
  ThreadId,
  WorkItemSummary,
} from "@t3tools/contracts";

import { FACTORY_ROLE_LABELS } from "./workItems.logic";

export const CANVAS_NODE_WIDTH = 148;
export const CANVAS_NODE_HEIGHT = 44;
const COLUMN_GAP = 112;
const ROW_GAP = 16;
const PADDING = 8;

export type CanvasNodeKind = "trigger" | "foreman" | "implement" | "review" | "gate" | "output";

export interface CanvasNode {
  readonly id: string;
  readonly kind: CanvasNodeKind;
  readonly label: string;
  readonly layer: number;
  readonly x: number;
  readonly y: number;
}

export interface CanvasEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** A cubic from the right middle of `from` to the left middle of `to`. */
  readonly path: string;
  readonly midX: number;
  readonly midY: number;
}

export interface FactoryGraph {
  readonly nodes: ReadonlyArray<CanvasNode>;
  readonly edges: ReadonlyArray<CanvasEdge>;
  readonly width: number;
  readonly height: number;
}

export interface FactoryGraphInput {
  readonly scheduledTaskIds: ReadonlyArray<ScheduledTaskId>;
  /** Null until the scheduled task list answers; a trigger then shows its id. */
  readonly scheduledTasks: ReadonlyArray<{
    readonly id: ScheduledTaskId;
    readonly title: string;
  }> | null;
}

const MANUAL_TRIGGER_NODE = "trigger:manual";
const triggerNodeId = (taskId: ScheduledTaskId) => `trigger:${taskId}`;

/** Layered left to right: triggers, the Foreman, the three things it spawns, the output. */
export function factoryGraph(input: FactoryGraphInput): FactoryGraph {
  const triggers = [
    ...input.scheduledTaskIds.map((taskId) => ({
      id: triggerNodeId(taskId),
      label: input.scheduledTasks?.find((task) => task.id === taskId)?.title ?? taskId,
    })),
    { id: MANUAL_TRIGGER_NODE, label: "Manual" },
  ];
  const layers: ReadonlyArray<ReadonlyArray<Omit<CanvasNode, "layer" | "x" | "y">>> = [
    triggers.map((trigger) => ({ ...trigger, kind: "trigger" as const })),
    [{ id: "foreman", kind: "foreman", label: FACTORY_ROLE_LABELS.foreman }],
    [
      { id: "implement", kind: "implement", label: FACTORY_ROLE_LABELS.implement },
      { id: "review", kind: "review", label: FACTORY_ROLE_LABELS.review },
      { id: "gate", kind: "gate", label: "Gate" },
    ],
    [{ id: "output", kind: "output", label: "Output" }],
  ];
  const rows = Math.max(...layers.map((layer) => layer.length));
  const height = PADDING * 2 + rows * CANVAS_NODE_HEIGHT + (rows - 1) * ROW_GAP;
  const width = PADDING * 2 + layers.length * CANVAS_NODE_WIDTH + (layers.length - 1) * COLUMN_GAP;
  const nodes = layers.flatMap((layer, index) => {
    const span = layer.length * CANVAS_NODE_HEIGHT + (layer.length - 1) * ROW_GAP;
    const top = (height - span) / 2;
    return layer.map((node, row) => ({
      ...node,
      layer: index,
      x: PADDING + index * (CANVAS_NODE_WIDTH + COLUMN_GAP),
      y: top + row * (CANVAS_NODE_HEIGHT + ROW_GAP),
    }));
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edge = (from: string, to: string): CanvasEdge => {
    const source = byId.get(from)!;
    const target = byId.get(to)!;
    const x1 = source.x + CANVAS_NODE_WIDTH;
    const y1 = source.y + CANVAS_NODE_HEIGHT / 2;
    const x2 = target.x;
    const y2 = target.y + CANVAS_NODE_HEIGHT / 2;
    const midX = (x1 + x2) / 2;
    return {
      id: `${from}->${to}`,
      from,
      to,
      path: `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`,
      midX,
      midY: (y1 + y2) / 2,
    };
  };
  const edges = [
    ...triggers.map((trigger) => edge(trigger.id, "foreman")),
    edge("foreman", "implement"),
    edge("foreman", "review"),
    edge("foreman", "gate"),
    edge("foreman", "output"),
  ];
  return { nodes, edges, width, height };
}

export interface CanvasNodeState {
  readonly lit: boolean;
  /** The thread a click opens: the lit run, or for the Foreman its thread. */
  readonly threadId: ThreadId | null;
  /** A second line under the label, for the output node. */
  readonly detail: string | null;
}

export interface CanvasEdgeState {
  readonly lit: boolean;
  readonly title: string | null;
  /** Items on this edge after the first. */
  readonly more: number;
  readonly threadId: ThreadId | null;
}

export interface FactoryGraphState {
  readonly graph: FactoryGraph;
  readonly nodes: ReadonlyMap<string, CanvasNodeState>;
  readonly edges: ReadonlyMap<string, CanvasEdgeState>;
}

export type CanvasShell = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "runtime" | "branch" | "linkedPullRequest" | "branchPullRequest"
>;

export interface FactoryGraphStateInput {
  readonly environmentId: EnvironmentId;
  readonly threads: ReadonlyArray<FactoryThread>;
  readonly shells: ReadonlyArray<CanvasShell>;
  /** The factory's active work items. */
  readonly items: ReadonlyArray<WorkItemSummary>;
}

interface OwnedActivity {
  foreman: ThreadId | null;
  implement: ThreadId | null;
  review: ThreadId | null;
  outputBranch: string | null;
  outputPullRequest: number | null;
}

const emptyActivity = (): OwnedActivity => ({
  foreman: null,
  implement: null,
  review: null,
  outputBranch: null,
  outputPullRequest: null,
});

function ownedRoles(threads: ReadonlyArray<FactoryThread>): ReadonlyMap<ThreadId, FactoryRoleName> {
  const roles = new Map<ThreadId, FactoryRoleName>();
  for (const thread of threads) if (thread.role !== null) roles.set(thread.threadId, thread.role);
  return roles;
}

function outputThreadOf(items: ReadonlyArray<WorkItemSummary>): ThreadId | null {
  const item = items.find((candidate) => candidate.stage !== "queued");
  return item?.threads.find((thread) => thread.role === "implement")?.threadId ?? null;
}

/** One pass over the shells, writing into `into` so an unchanged scan allocates nothing. */
function scanActivity(
  into: OwnedActivity,
  environmentId: EnvironmentId,
  roles: ReadonlyMap<ThreadId, FactoryRoleName>,
  outputThreadId: ThreadId | null,
  shells: ReadonlyArray<CanvasShell>,
) {
  into.foreman = null;
  into.implement = null;
  into.review = null;
  into.outputBranch = null;
  into.outputPullRequest = null;
  for (const shell of shells) {
    if (shell.environmentId !== environmentId) continue;
    if (shell.id === outputThreadId) {
      into.outputBranch = shell.branch;
      into.outputPullRequest = (shell.linkedPullRequest ?? shell.branchPullRequest)?.number ?? null;
    }
    const role = roles.get(shell.id);
    if (role === undefined || into[role] !== null || !threadRuntimeIsActive(shell.runtime))
      continue;
    into[role] = shell.id;
  }
}

const sameActivity = (a: OwnedActivity, b: OwnedActivity) =>
  a.foreman === b.foreman &&
  a.implement === b.implement &&
  a.review === b.review &&
  a.outputBranch === b.outputBranch &&
  a.outputPullRequest === b.outputPullRequest;

function edgeOfItem(item: WorkItemSummary): string | null {
  switch (item.stage) {
    case "new":
      return `${
        item.source.kind === "scheduled_task"
          ? triggerNodeId(item.source.scheduledTaskId)
          : MANUAL_TRIGGER_NODE
      }->foreman`;
    case "implement":
      return "foreman->implement";
    case "review":
      return "foreman->review";
    case "waiting":
      return "foreman->gate";
    default:
      return null;
  }
}

function itemThread(item: WorkItemSummary): ThreadId | null {
  const role = item.stage === "implement" || item.stage === "review" ? item.stage : null;
  return (
    (role === null ? undefined : item.threads.find((thread) => thread.role === role)?.threadId) ??
    item.foremanThreadId
  );
}

function buildState(
  graph: FactoryGraph,
  threads: ReadonlyArray<FactoryThread>,
  items: ReadonlyArray<WorkItemSummary>,
  activity: OwnedActivity,
): FactoryGraphState {
  const onEdge = new Map<string, WorkItemSummary[]>();
  for (const item of items) {
    const edgeId = edgeOfItem(item);
    if (edgeId === null) continue;
    const list = onEdge.get(edgeId);
    if (list === undefined) onEdge.set(edgeId, [item]);
    else list.push(item);
  }
  const edges = new Map<string, CanvasEdgeState>();
  for (const edge of graph.edges) {
    const list = onEdge.get(edge.id);
    const first = list?.[0];
    edges.set(
      edge.id,
      first === undefined
        ? UNLIT_EDGE
        : { lit: true, title: first.title, more: list!.length - 1, threadId: itemThread(first) },
    );
  }
  const waiting = items.find((item) => item.stage === "waiting");
  const foremanThread = threads.find((thread) => thread.role === "foreman")?.threadId ?? null;
  const nodes = new Map<string, CanvasNodeState>();
  for (const node of graph.nodes) {
    switch (node.kind) {
      case "foreman":
        nodes.set(node.id, {
          lit: activity.foreman !== null,
          threadId: activity.foreman ?? foremanThread,
          detail: null,
        });
        break;
      case "implement":
      case "review":
        nodes.set(node.id, {
          lit: activity[node.kind] !== null,
          threadId: activity[node.kind],
          detail: null,
        });
        break;
      case "gate":
        nodes.set(node.id, {
          lit: waiting !== undefined,
          threadId: waiting?.foremanThreadId ?? null,
          detail: null,
        });
        break;
      case "output": {
        const threadId = outputThreadOf(items);
        nodes.set(node.id, {
          lit: false,
          threadId,
          detail:
            activity.outputPullRequest !== null
              ? `PR #${activity.outputPullRequest}`
              : (activity.outputBranch ?? "Branch or PR"),
        });
        break;
      }
      case "trigger":
        nodes.set(node.id, UNLIT_NODE);
    }
  }
  return { graph, nodes, edges };
}

const UNLIT_NODE: CanvasNodeState = { lit: false, threadId: null, detail: null };
const UNLIT_EDGE: CanvasEdgeState = { lit: false, title: null, more: 0, threadId: null };

/** The live state of each node and edge, from owned thread activity and the active work items. */
export function factoryGraphState(
  graph: FactoryGraph,
  input: FactoryGraphStateInput,
): FactoryGraphState {
  const activity = emptyActivity();
  scanActivity(
    activity,
    input.environmentId,
    ownedRoles(input.threads),
    outputThreadOf(input.items),
    input.shells,
  );
  return buildState(graph, input.threads, input.items, activity);
}

const sameGraph = (a: FactoryGraph, b: FactoryGraph) =>
  a.nodes.length === b.nodes.length &&
  a.nodes.every(
    (node, index) => node.id === b.nodes[index]!.id && node.label === b.nodes[index]!.label,
  );

function sameMap<V>(
  a: ReadonlyMap<string, V>,
  b: ReadonlyMap<string, V>,
  same: (x: V, y: V) => boolean,
) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (other === undefined || !same(value, other)) return false;
  }
  return true;
}

const sameNodeState = (a: CanvasNodeState, b: CanvasNodeState) =>
  a.lit === b.lit && a.threadId === b.threadId && a.detail === b.detail;
const sameEdgeState = (a: CanvasEdgeState, b: CanvasEdgeState) =>
  a.lit === b.lit && a.title === b.title && a.more === b.more && a.threadId === b.threadId;

export type FactoryCanvasInput = FactoryGraphInput & FactoryGraphStateInput;

/**
 * A stateful selector for one canvas. It returns the previous state while nothing the canvas shows
 * changed, and when only the shells changed it scans them once without allocating.
 */
export function createFactoryCanvasSelector() {
  let previous: FactoryGraphState | null = null;
  let previousInput: FactoryCanvasInput | null = null;
  let roles: ReadonlyMap<ThreadId, FactoryRoleName> = new Map();
  let outputThreadId: ThreadId | null = null;
  let activity = emptyActivity();
  let scratch = emptyActivity();

  return (input: FactoryCanvasInput): FactoryGraphState => {
    const definitionSame =
      previousInput !== null &&
      previousInput.scheduledTaskIds === input.scheduledTaskIds &&
      previousInput.scheduledTasks === input.scheduledTasks;
    const workSame =
      previousInput !== null &&
      previousInput.environmentId === input.environmentId &&
      previousInput.threads === input.threads &&
      previousInput.items === input.items;
    if (!workSame) {
      roles = ownedRoles(input.threads);
      outputThreadId = outputThreadOf(input.items);
    }
    scanActivity(scratch, input.environmentId, roles, outputThreadId, input.shells);
    const activitySame = sameActivity(scratch, activity);
    previousInput = input;
    if (previous !== null && definitionSame && workSame && activitySame) return previous;
    if (!activitySame) [activity, scratch] = [scratch, activity];

    let graph = previous !== null && definitionSame ? previous.graph : factoryGraph(input);
    if (previous !== null && sameGraph(previous.graph, graph)) graph = previous.graph;
    const next = buildState(graph, input.threads, input.items, activity);
    if (
      previous !== null &&
      graph === previous.graph &&
      sameMap(previous.nodes, next.nodes, sameNodeState) &&
      sameMap(previous.edges, next.edges, sameEdgeState)
    ) {
      return previous;
    }
    previous = next;
    return next;
  };
}

/** SVG text does not truncate itself; the full text goes in a `<title>`. */
export const truncateLabel = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;
