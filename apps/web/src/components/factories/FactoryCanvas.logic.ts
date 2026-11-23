import {
  factoryRoleLabel,
  implementationLabel,
  latestImplementation,
} from "@t3tools/client-runtime/factories";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  type EnvironmentId,
  type Factory,
  FACTORY_FOREMAN_ROLE,
  type FactoryRoleName,
  type FactoryThread,
  type ScheduledTaskId,
  type ThreadId,
  type WorkItemSummary,
} from "@t3tools/contracts";

import { msg } from "gt-react";

import { m } from "../../i18n/messages";

export const CANVAS_NODE_WIDTH = 148;
export const CANVAS_NODE_HEIGHT = 44;
const COLUMN_GAP = 112;
const ROW_GAP = 16;
const PADDING = 8;

export type CanvasNodeKind = "trigger" | "foreman" | "role" | "gate" | "output";

export interface CanvasNode {
  readonly id: string;
  readonly kind: CanvasNodeKind;
  readonly label: string;
  /** The role a foreman or role node stands for, which its click opens. */
  readonly role: FactoryRoleName | null;
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
  /** The roles the Foreman can delegate to: enabled, in order, without the Foreman. */
  readonly roles: ReadonlyArray<FactoryRoleName>;
  readonly scheduledTaskIds: ReadonlyArray<ScheduledTaskId>;
  /** Null until the scheduled task list answers; a trigger then shows its id. */
  readonly scheduledTasks: ReadonlyArray<{
    readonly id: ScheduledTaskId;
    readonly title: string;
  }> | null;
}

const MANUAL_TRIGGER_NODE = "trigger:manual";
const triggerNodeId = (taskId: ScheduledTaskId) => `trigger:${taskId}`;
const ROLE_NODE_PREFIX = "role:";
const roleNodeId = (role: FactoryRoleName) => `${ROLE_NODE_PREFIX}${role}`;

/** A canvas draws the factory's enabled roles besides the Foreman. */
export const canvasRoles = (factory: Factory): ReadonlyArray<FactoryRoleName> =>
  factory.roles
    .filter((role) => role.role !== FACTORY_FOREMAN_ROLE && role.enabled)
    .map((role) => role.role);

/** Layered left to right: triggers, the Foreman, its roles and the gate, the output. */
export function factoryGraph(input: FactoryGraphInput): FactoryGraph {
  const triggers = [
    ...input.scheduledTaskIds.map((taskId) => ({
      id: triggerNodeId(taskId),
      label: input.scheduledTasks?.find((task) => task.id === taskId)?.title ?? taskId,
    })),
    { id: MANUAL_TRIGGER_NODE, label: m(msg("Manual", { $context: "work started by hand" })) },
  ];
  const layers: ReadonlyArray<ReadonlyArray<Omit<CanvasNode, "layer" | "x" | "y">>> = [
    triggers.map((trigger) => ({ ...trigger, kind: "trigger" as const, role: null })),
    [
      {
        id: "foreman",
        kind: "foreman",
        label: factoryRoleLabel(FACTORY_FOREMAN_ROLE, m),
        role: FACTORY_FOREMAN_ROLE,
      },
    ],
    [
      ...input.roles.map((role) => ({
        id: roleNodeId(role),
        kind: "role" as const,
        label: factoryRoleLabel(role, m),
        role,
      })),
      {
        id: "gate",
        kind: "gate",
        label: m(msg("Gate", { $context: "work item gate" })),
        role: null,
      },
    ],
    [
      {
        id: "output",
        kind: "output",
        label: m(msg("Output", { $context: "what a factory produces" })),
        role: null,
      },
    ],
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
    ...input.roles.map((role) => edge("foreman", roleNodeId(role))),
    edge("foreman", "gate"),
    edge("foreman", "output"),
  ];
  return { nodes, edges, width, height };
}

export interface CanvasNodeState {
  readonly lit: boolean;
  /** The thread a click opens: the first lit run. */
  readonly threadId: ThreadId | null;
  /** A second line under the label: the output's branch, or how many of a role's threads run. */
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
  /** Each role's running threads, the Foreman's included. */
  readonly roles: Map<FactoryRoleName, Array<ThreadId>>;
  /** Every running thread the factory owns. */
  readonly active: Set<ThreadId>;
  outputBranch: string | null;
  outputPullRequest: number | null;
}

const emptyActivity = (): OwnedActivity => ({
  roles: new Map(),
  active: new Set(),
  outputBranch: null,
  outputPullRequest: null,
});

function ownedRoles(threads: ReadonlyArray<FactoryThread>): ReadonlyMap<ThreadId, FactoryRoleName> {
  const roles = new Map<ThreadId, FactoryRoleName>();
  for (const thread of threads) if (thread.role !== null) roles.set(thread.threadId, thread.role);
  return roles;
}

/** The implementer of the first item that has one, since several items can run at once. */
function outputThreadOf(items: ReadonlyArray<WorkItemSummary>): ThreadId | null {
  for (const item of items) {
    const implementer = item.threads.find((thread) => thread.role === "implement");
    if (implementer !== undefined) return implementer.threadId;
  }
  return null;
}

/** The implementation the output node names: the first item's that has one. */
function outputImplementationOf(items: ReadonlyArray<WorkItemSummary>) {
  for (const item of items) {
    const implemented = latestImplementation(item);
    if (implemented !== null) return implemented;
  }
  return null;
}

/** One pass over the shells, writing into `into` so the selector can compare it with the last. */
function scanActivity(
  into: OwnedActivity,
  environmentId: EnvironmentId,
  roles: ReadonlyMap<ThreadId, FactoryRoleName>,
  outputThreadId: ThreadId | null,
  shells: ReadonlyArray<CanvasShell>,
) {
  into.roles.clear();
  into.active.clear();
  into.outputBranch = null;
  into.outputPullRequest = null;
  for (const shell of shells) {
    if (shell.environmentId !== environmentId) continue;
    if (shell.id === outputThreadId) {
      into.outputBranch = shell.branch;
      into.outputPullRequest = (shell.linkedPullRequest ?? shell.branchPullRequest)?.number ?? null;
    }
    const role = roles.get(shell.id);
    if (role === undefined || !threadRuntimeIsActive(shell.runtime)) continue;
    into.active.add(shell.id);
    const running = into.roles.get(role);
    if (running === undefined) into.roles.set(role, [shell.id]);
    else running.push(shell.id);
  }
}

const sameActivity = (a: OwnedActivity, b: OwnedActivity) =>
  sameMap(a.roles, b.roles, (x, y) => x.length === y.length && x.every((id, i) => id === y[i])) &&
  a.outputBranch === b.outputBranch &&
  a.outputPullRequest === b.outputPullRequest;

interface ItemOnEdge {
  readonly item: WorkItemSummary;
  /** The thread the edge opens: the role's running child, or the item's run. */
  readonly threadId: ThreadId | null;
}

/**
 * The edges an item is on: its trigger's while new, the gate's while waiting, and while working
 * one per role it has a child running as, since several roles can work on it at once.
 */
function edgesOfItem(
  item: WorkItemSummary,
  active: ReadonlySet<ThreadId>,
): ReadonlyArray<readonly [string, ItemOnEdge]> {
  switch (item.stage) {
    case "new":
      return [
        [
          `${
            item.source.kind === "scheduled_task"
              ? triggerNodeId(item.source.scheduledTaskId)
              : item.source.kind === "trigger"
                ? triggerNodeId(item.source.triggerId)
                : MANUAL_TRIGGER_NODE
          }->foreman`,
          { item, threadId: item.foremanThreadId },
        ],
      ];
    case "waiting":
      return [["foreman->gate", { item, threadId: item.foremanThreadId }]];
    case "working": {
      const edges = new Map<string, ItemOnEdge>();
      for (const thread of item.threads) {
        if (thread.role === null || !active.has(thread.threadId)) continue;
        const edgeId = `foreman->${roleNodeId(thread.role)}`;
        if (!edges.has(edgeId)) edges.set(edgeId, { item, threadId: thread.threadId });
      }
      return [...edges];
    }
    default:
      return [];
  }
}

function buildState(
  graph: FactoryGraph,
  items: ReadonlyArray<WorkItemSummary>,
  activity: OwnedActivity,
): FactoryGraphState {
  const onEdge = new Map<string, ItemOnEdge[]>();
  for (const item of items) {
    for (const [edgeId, entry] of edgesOfItem(item, activity.active)) {
      const list = onEdge.get(edgeId);
      if (list === undefined) onEdge.set(edgeId, [entry]);
      else list.push(entry);
    }
  }
  const edges = new Map<string, CanvasEdgeState>();
  for (const edge of graph.edges) {
    const list = onEdge.get(edge.id);
    const first = list?.[0];
    edges.set(
      edge.id,
      first === undefined
        ? UNLIT_EDGE
        : {
            lit: true,
            title: first.item.title,
            more: list!.length - 1,
            threadId: first.threadId,
          },
    );
  }
  const waiting = items.find((item) => item.stage === "waiting");
  const nodes = new Map<string, CanvasNodeState>();
  for (const node of graph.nodes) {
    switch (node.kind) {
      case "foreman":
      case "role": {
        const running =
          activity.roles.get(
            node.kind === "foreman" ? FACTORY_FOREMAN_ROLE : node.id.slice(ROLE_NODE_PREFIX.length),
          ) ?? [];
        nodes.set(node.id, {
          lit: running.length > 0,
          threadId: running[0] ?? null,
          detail:
            running.length > 1
              ? m(msg("{count} running", { count: String(running.length) }))
              : null,
        });
        break;
      }
      case "gate":
        nodes.set(node.id, {
          lit: waiting !== undefined,
          threadId: waiting?.foremanThreadId ?? null,
          detail: null,
        });
        break;
      case "output": {
        const threadId = outputThreadOf(items);
        // What the implementer returned beats its thread's branch, which a task can leave wrong.
        const implemented = outputImplementationOf(items);
        nodes.set(node.id, {
          lit: false,
          threadId,
          detail:
            activity.outputPullRequest !== null
              ? m(msg("PR #{number}", { number: String(activity.outputPullRequest) }))
              : implemented !== null
                ? implementationLabel(implemented)
                : (activity.outputBranch ?? m(msg("Branch or PR"))),
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
  return buildState(graph, input.items, activity);
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
      previousInput.roles.join("\n") === input.roles.join("\n") &&
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
    const next = buildState(graph, input.items, activity);
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
