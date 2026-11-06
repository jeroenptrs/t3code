import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, FactoryId, ThreadId, WorkItemSummary } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { factoriesEnvironment } from "../../state/factories";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import {
  CANVAS_NODE_HEIGHT,
  CANVAS_NODE_WIDTH,
  createFactoryCanvasSelector,
  truncateLabel,
  type CanvasEdge,
  type CanvasEdgeState,
  type CanvasNode,
  type CanvasNodeState,
} from "./FactoryCanvas.logic";

const NO_ITEMS: ReadonlyArray<WorkItemSummary> = [];

const factoryCanvasAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((factoryId: FactoryId) => {
    const select = createFactoryCanvasSelector();
    return Atom.make((get) => {
      const factory = AsyncResult.getOrElse(
        get(factoriesEnvironment.read({ environmentId, input: { factoryId } })),
        () => null,
      );
      if (factory === null) return null;
      const tasks = AsyncResult.getOrElse(
        get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} })),
        () => null,
      );
      const items = AsyncResult.getOrElse(
        get(
          factoriesEnvironment.workItems({
            environmentId,
            input: { factoryId, outcome: "active" },
          }),
        ),
        () => null,
      );
      return select({
        environmentId,
        scheduledTaskIds: factory.scheduledTaskIds,
        scheduledTasks: tasks?.tasks ?? null,
        threads: factory.threads,
        shells: get(environmentThreadShells.threadShellsAtom),
        items: items?.workItems ?? NO_ITEMS,
      });
    }).pipe(Atom.withLabel(`web-factory-canvas:${environmentId}:${factoryId}`));
  }),
);

function ThreadAnchor(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly children: ReactNode;
}) {
  if (props.threadId === null) return props.children;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId: props.environmentId, threadId: props.threadId }}
      className="cursor-pointer"
    >
      {props.children}
    </Link>
  );
}

function CanvasNodeShape(props: {
  readonly environmentId: EnvironmentId;
  readonly node: CanvasNode;
  readonly state: CanvasNodeState;
}) {
  const { node, state } = props;
  const label = truncateLabel(node.label, 20);
  const centerY = node.y + CANVAS_NODE_HEIGHT / 2;
  return (
    <ThreadAnchor environmentId={props.environmentId} threadId={state.threadId}>
      <g data-node={node.id} data-lit={state.lit} aria-label={node.label}>
        <title>{state.detail === null ? node.label : `${node.label}: ${state.detail}`}</title>
        {state.lit ? (
          <rect
            x={node.x - 3}
            y={node.y - 3}
            width={CANVAS_NODE_WIDTH + 6}
            height={CANVAS_NODE_HEIGHT + 6}
            rx={10}
            fill="none"
            className="stroke-primary/30"
            strokeWidth={2}
          />
        ) : null}
        <rect
          x={node.x}
          y={node.y}
          width={CANVAS_NODE_WIDTH}
          height={CANVAS_NODE_HEIGHT}
          rx={8}
          className={state.lit ? "fill-primary/10 stroke-primary" : "fill-card stroke-border"}
          strokeWidth={state.lit ? 2 : 1}
        />
        <text
          x={node.x + 12}
          y={state.detail === null ? centerY : centerY - 7}
          dominantBaseline="middle"
          className={cn(
            "text-xs",
            node.kind === "trigger" ? "fill-muted-foreground" : "fill-foreground",
          )}
        >
          {label}
        </text>
        {state.detail === null ? null : (
          <text
            x={node.x + 12}
            y={centerY + 8}
            dominantBaseline="middle"
            className="fill-muted-foreground text-3xs"
          >
            {truncateLabel(state.detail, 22)}
          </text>
        )}
      </g>
    </ThreadAnchor>
  );
}

function CanvasEdgeLine(props: {
  readonly environmentId: EnvironmentId;
  readonly edge: CanvasEdge;
  readonly state: CanvasEdgeState;
}) {
  const { edge, state } = props;
  const line = (
    <path
      d={edge.path}
      fill="none"
      className={state.lit ? "stroke-primary" : "stroke-border"}
      strokeWidth={state.lit ? 2.5 : 1.5}
    />
  );
  if (!state.lit || state.title === null) return line;
  const text = `${truncateLabel(state.title, 16)}${state.more === 0 ? "" : ` +${state.more}`}`;
  return (
    <ThreadAnchor environmentId={props.environmentId} threadId={state.threadId}>
      <g data-edge={edge.id} data-lit aria-label={state.title}>
        <title>{state.title}</title>
        {line}
        <text
          x={edge.midX}
          y={edge.midY - 6}
          textAnchor="middle"
          paintOrder="stroke"
          strokeWidth={4}
          className="fill-foreground stroke-background text-3xs"
        >
          {text}
        </text>
      </g>
    </ThreadAnchor>
  );
}

/** Read-only: who may spawn whom in this factory, lit where runs and work items are right now. */
export function FactoryCanvas(props: {
  readonly environmentId: EnvironmentId;
  readonly factoryId: FactoryId;
}) {
  const { environmentId } = props;
  const canvas = useAtomValue(factoryCanvasAtom(environmentId)(props.factoryId));
  if (canvas === null) return null;
  const { graph } = canvas;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="factory-canvas">
      <h2 id="factory-canvas" className="font-medium">
        Canvas
      </h2>
      <svg
        viewBox={`0 0 ${graph.width} ${graph.height}`}
        className="h-auto w-full max-w-4xl"
        aria-labelledby="factory-canvas"
      >
        {graph.edges.map((edge) => (
          <CanvasEdgeLine
            key={edge.id}
            environmentId={environmentId}
            edge={edge}
            state={canvas.edges.get(edge.id)!}
          />
        ))}
        {graph.nodes.map((node) => (
          <CanvasNodeShape
            key={node.id}
            environmentId={environmentId}
            node={node}
            state={canvas.nodes.get(node.id)!}
          />
        ))}
      </svg>
    </section>
  );
}
