/**
 * Fork-only Insights client state. Administrators read estimated coding output per contributor
 * and configure which projects and people the server's ingestion covers. Nothing here polls:
 * ingestion runs in the background on the server, and a view re-reads when shown again after its
 * stale time or when a configuration change lands.
 */
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createInsightsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // Every configuration change can change the numbers too: enabling a project, including or
  // excluding a person, and merging two people all add or drop rows. Bumping this re-reads
  // whatever is mounted and marks the rest stale.
  const epoch = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.withLabel("environment-data:insights:epoch")),
  );
  const refreshTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    epoch(environmentId);
  const changed = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.update(epoch(environmentId), (value) => value + 1));
  // One configuration change at a time per environment, so two toggles cannot land out of order.
  const serial = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: EnvironmentId }) => environmentId,
  };

  return {
    /** Weekly trend and the contributor table for one window. */
    overview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:insights:overview",
      tag: WS_METHODS.insightsOverview,
      staleTimeMs: 60_000,
      refreshTrigger,
    }),
    /** Settings, projects with their sync status, and every known contributor. */
    config: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:insights:config",
      tag: WS_METHODS.insightsConfig,
      staleTimeMs: 30_000,
      refreshTrigger,
    }),
    /** Re-reads both views, for an explicit refresh. */
    refresh: (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) =>
      registry.update(epoch(environmentId), (value) => value + 1),
    updateSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:insights:update-settings",
      tag: WS_METHODS.insightsUpdateSettings,
      concurrency: serial,
      onSuccess: (target, registry) => changed(target, registry),
    }),
    setProjectEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:insights:set-project-enabled",
      tag: WS_METHODS.insightsSetProjectEnabled,
      concurrency: serial,
      onSuccess: (target, registry) => changed(target, registry),
    }),
    rescanProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:insights:rescan-project",
      tag: WS_METHODS.insightsRescanProject,
      concurrency: serial,
      onSuccess: (target, registry) => changed(target, registry),
    }),
    updateContributor: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:insights:update-contributor",
      tag: WS_METHODS.insightsUpdateContributor,
      concurrency: serial,
      onSuccess: (target, registry) => changed(target, registry),
    }),
    mergeContributors: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:insights:merge-contributors",
      tag: WS_METHODS.insightsMergeContributors,
      concurrency: serial,
      onSuccess: (target, registry) => changed(target, registry),
    }),
  };
}
