/**
 * Fork-only software factories client state. Operators read factories, what they own, and their
 * work items; administrators save definitions and skills, create work items, and answer gates. Nothing here
 * polls: a view re-reads when shown again after its stale time or when a command lands.
 */
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createFactoriesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // A save can change any factory's summary, such as which scheduled tasks it owns, and a work
  // item command changes its factory's attention, so each re-reads whatever is mounted and marks
  // the rest stale.
  const epoch = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.withLabel("environment-data:factories:epoch")),
  );
  const refreshTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    epoch(environmentId);
  const bumpEpoch = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.update(epoch(environmentId), (value) => value + 1));

  return {
    /** Every factory in the environment, or in one project, with its attention count. */
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:factories:list",
      tag: WS_METHODS.factoriesList,
      staleTimeMs: 15_000,
      refreshTrigger,
    }),
    /** One factory: its definition, each role's effective binding and body, and what it owns. */
    read: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:factories:read",
      tag: WS_METHODS.factoriesRead,
      staleTimeMs: 15_000,
      refreshTrigger,
    }),
    /** One factory's work items, newest first, filtered by stage, role, or outcome. */
    workItems: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:factories:work-items",
      tag: WS_METHODS.factoriesWorkItemsList,
      staleTimeMs: 15_000,
      refreshTrigger,
    }),
    /** One work item with its threads, gate, and transitions. */
    workItem: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:factories:work-item",
      tag: WS_METHODS.factoriesWorkItemsRead,
      staleTimeMs: 15_000,
      refreshTrigger,
    }),
    /** One skill's SKILL.md at one level: built-in, home, or the factory's. */
    skill: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:factories:skill",
      tag: WS_METHODS.factoriesSkillsRead,
      staleTimeMs: 15_000,
      refreshTrigger,
    }),
    /** Re-reads every view, for an explicit refresh. */
    refresh: (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) =>
      registry.update(epoch(environmentId), (value) => value + 1),
    save: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factories:save",
      tag: WS_METHODS.factoriesSave,
      // One save at a time per environment, so two edits cannot land out of order.
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
      onSuccess: bumpEpoch,
    }),
    /** Removes the factory's directory and work items; its threads return to Home. */
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factories:delete",
      tag: WS_METHODS.factoriesDelete,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
      onSuccess: bumpEpoch,
    }),
    /** Writes a home or factory skill's SKILL.md; every factory that sees it re-reads. */
    saveSkill: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factories:save-skill",
      tag: WS_METHODS.factoriesSkillsSave,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
      onSuccess: bumpEpoch,
    }),
    deleteSkill: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factories:delete-skill",
      tag: WS_METHODS.factoriesSkillsDelete,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
      onSuccess: bumpEpoch,
    }),
    /** Sends a request to the factory's Foreman as a new work item. */
    createWorkItem: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factories:create-work-item",
      tag: WS_METHODS.factoriesWorkItemsCreate,
      onSuccess: bumpEpoch,
    }),
    /** Approves or rejects the question a gate holds the item on. */
    answerWorkItemGate: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factories:answer-work-item-gate",
      tag: WS_METHODS.factoriesWorkItemsAnswerGate,
      // A second press while the first is in flight joins it instead of answering again.
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.workItemId}`,
      },
      onSuccess: bumpEpoch,
    }),
  };
}
