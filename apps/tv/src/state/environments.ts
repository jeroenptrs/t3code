import { createEnvironmentCatalogAtoms } from "@t3tools/client-runtime/state/connections";
import {
  createEnvironmentPresentationAtoms,
  createEnvironmentSummaryAtoms,
} from "@t3tools/client-runtime/state/presentation";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import { createEnvironmentShellAtoms } from "@t3tools/client-runtime/state/shell";
import { createEnvironmentProjectAtoms } from "@t3tools/client-runtime/state/projects";
import {
  createEnvironmentThreadShellAtoms,
  createOlderSettledThreadAtoms,
  createThreadFamilyAtoms,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

// The same client-runtime atom factories apps/mobile/src/state wires up, for the subset the TV
// renders: the catalog, each environment's connection, and its shell (projects and threads).

export const environmentCatalog = createEnvironmentCatalogAtoms(connectionAtomRuntime);

export const environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime);

export const serverEnvironment = createServerEnvironmentAtoms(connectionAtomRuntime, {
  initialConfigValueAtom: environmentSession.initialConfigValueAtom,
});

export const environmentPresentations = createEnvironmentPresentationAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  stateAtom: environmentCatalog.stateAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});

export const environmentSummaries = createEnvironmentSummaryAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  presentationAtom: environmentPresentations.presentationAtom,
});

export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);

// Shells leave older settled threads (and idle subagents) to on-demand reads; the snapshot
// merges the pages the Settled shelf loads, as apps/mobile/src/state/threads.ts does.
export const threadFamilies = createThreadFamilyAtoms(
  connectionAtomRuntime,
  environmentShell.stateAtom,
);
export const olderSettledThreads = createOlderSettledThreadAtoms(
  connectionAtomRuntime,
  environmentShell.stateAtom,
);
export const environmentSnapshotAtom = threadFamilies.snapshotAtom;

export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});

export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});

const NO_ENVIRONMENT_IDS: ReadonlySet<EnvironmentId> = new Set();

/** Environments whose servers support settling and snoozing, which decide the list's shelves. */
export const threadListCapabilitiesAtom = Atom.make((get) => {
  const settlement = new Set<EnvironmentId>();
  const snooze = new Set<EnvironmentId>();
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    const capabilities = get(serverEnvironment.configValueAtom(environmentId))?.environment
      .capabilities;
    if (capabilities?.threadSettlement === true) settlement.add(environmentId);
    if (capabilities?.threadSnooze === true) snooze.add(environmentId);
  }
  const previous = Option.getOrNull(
    get.self<{
      readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
      readonly snoozeEnvironmentIds: ReadonlySet<EnvironmentId>;
    }>(),
  );
  const same = (left: ReadonlySet<EnvironmentId>, right: ReadonlySet<EnvironmentId>) =>
    left.size === right.size && [...left].every((id) => right.has(id));
  if (
    previous !== null &&
    same(previous.settlementEnvironmentIds, settlement) &&
    same(previous.snoozeEnvironmentIds, snooze)
  ) {
    return previous;
  }
  return {
    settlementEnvironmentIds: settlement.size === 0 ? NO_ENVIRONMENT_IDS : settlement,
    snoozeEnvironmentIds: snooze.size === 0 ? NO_ENVIRONMENT_IDS : snooze,
  };
}).pipe(Atom.withLabel("tv-thread-list-capabilities"));

/**
 * Mounted by the main screen so every environment's session stays loaded: thread actions check
 * its scopes outside any component that reads it.
 */
export const environmentSessionsAtom = Atom.make((get) => {
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    get(environmentSession.sessionStateAtom(environmentId));
  }
}).pipe(Atom.withLabel("tv-environment-sessions"));

const NO_PROVIDER_NAMES: ReadonlyMap<string, string> = new Map();

/** Provider display names by `environmentId:instanceId`, for the thread rows' provider label. */
export const providerNamesAtom = Atom.make((get): ReadonlyMap<string, string> => {
  const names = new Map<string, string>();
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    for (const provider of get(serverEnvironment.configValueAtom(environmentId))?.providers ?? []) {
      names.set(
        `${environmentId}:${provider.instanceId}`,
        resolveProviderInstanceDisplayName(provider),
      );
    }
  }
  const previous = Option.getOrNull(get.self<ReadonlyMap<string, string>>());
  if (
    previous !== null &&
    previous.size === names.size &&
    [...names].every(([key, name]) => previous.get(key) === name)
  ) {
    return previous;
  }
  return names.size === 0 ? NO_PROVIDER_NAMES : names;
}).pipe(Atom.withLabel("tv-provider-names"));
