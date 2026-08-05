import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  SCHEDULED_AUTOMATION_WS_METHODS,
  DEFAULT_SCHEDULED_AUTOMATION_HEALTH,
  type ScheduledAutomationHealth,
  type ScheduledAutomationStreamItem,
  type ScheduledAutomationView,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../connection/runtime";

export function compareScheduledAutomationViews(
  left: ScheduledAutomationView,
  right: ScheduledAutomationView,
): number {
  return (
    left.automation.createdAt.localeCompare(right.automation.createdAt) ||
    left.automation.id.localeCompare(right.automation.id)
  );
}

export function applyScheduledAutomationStreamItem(
  current: ReadonlyArray<ScheduledAutomationView>,
  item: ScheduledAutomationStreamItem,
): ReadonlyArray<ScheduledAutomationView> {
  if (item.kind === "snapshot") return item.automations.toSorted(compareScheduledAutomationViews);
  if (item.kind === "removed") {
    return current.filter((view) => view.automation.id !== item.automationId);
  }
  const withoutCurrent = current.filter(
    (view) => view.automation.id !== item.automation.automation.id,
  );
  return [...withoutCurrent, item.automation].toSorted(compareScheduledAutomationViews);
}

export function projectScheduledAutomationStream<E, R>(
  stream: Stream.Stream<ScheduledAutomationStreamItem, E, R>,
): Stream.Stream<ReadonlyArray<ScheduledAutomationView>, E, R> {
  return stream.pipe(
    Stream.scan([] as ReadonlyArray<ScheduledAutomationView>, applyScheduledAutomationStreamItem),
    Stream.drop(1),
  );
}

export interface ScheduledAutomationState {
  readonly views: ReadonlyArray<ScheduledAutomationView>;
  readonly health: ScheduledAutomationHealth;
}

export const INITIAL_SCHEDULED_AUTOMATION_HEALTH = DEFAULT_SCHEDULED_AUTOMATION_HEALTH;

export function applyScheduledAutomationStateStreamItem(
  current: ScheduledAutomationState,
  item: ScheduledAutomationStreamItem,
): ScheduledAutomationState {
  if (item.kind === "snapshot") {
    return {
      views: item.automations.toSorted(compareScheduledAutomationViews),
      health: item.health,
    };
  }
  return { ...current, views: applyScheduledAutomationStreamItem(current.views, item) };
}

export function projectScheduledAutomationStateStream<E, R>(
  stream: Stream.Stream<ScheduledAutomationStreamItem, E, R>,
): Stream.Stream<ScheduledAutomationState, E, R> {
  return stream.pipe(
    Stream.scan(
      { views: [], health: INITIAL_SCHEDULED_AUTOMATION_HEALTH } as ScheduledAutomationState,
      applyScheduledAutomationStateStreamItem,
    ),
    Stream.drop(1),
  );
}

export const scheduledAutomationEnvironment = {
  state: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:scheduled-automations:state",
    tag: SCHEDULED_AUTOMATION_WS_METHODS.subscribe,
    idleTtlMs: 0,
    transform: projectScheduledAutomationStateStream,
  }),
  dispatch: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:scheduled-automations:dispatch",
    tag: SCHEDULED_AUTOMATION_WS_METHODS.dispatchCommand,
    concurrency: {
      mode: "serial",
      key: ({ environmentId, input }) => `${environmentId}:${input.automationId}`,
    },
  }),
};
