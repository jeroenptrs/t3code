import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  SCHEDULED_AUTOMATION_WS_METHODS,
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

export const scheduledAutomationEnvironment = {
  views: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:scheduled-automations",
    tag: SCHEDULED_AUTOMATION_WS_METHODS.subscribe,
    idleTtlMs: 0,
    transform: projectScheduledAutomationStream,
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
