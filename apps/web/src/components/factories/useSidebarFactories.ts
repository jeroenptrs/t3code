import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useRef } from "react";

import { useLocalStorage, writeLocalStorageValue } from "../../hooks/useLocalStorage";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  factoriesEnvironment,
  useFactoryEnvironments,
  type FactoryEnvironment,
} from "../../state/factories";
import {
  countThreadAttention,
  factoryOwnedThreadKeys,
  partitionFactoryThreads,
} from "../Sidebar.logic";
import { factoriesAttentionTotal, showsFactoriesTab } from "./factories.logic";

const SIDEBAR_TAB_KEY = "t3code:sidebar:tab";
const SidebarTab = Schema.Literals(["home", "factories"]);
export type SidebarTab = typeof SidebarTab.Type;

function refreshFactoryLists(environments: ReadonlyArray<FactoryEnvironment>) {
  for (const { environmentId, factories } of environments) {
    if (factories !== null) factoriesEnvironment.refresh(appAtomRegistry, environmentId);
  }
}

/** For the command palette: the sidebar shows the Factories tab next time it renders. */
export function openFactoriesTab(environments: ReadonlyArray<FactoryEnvironment>) {
  writeLocalStorageValue(SIDEBAR_TAB_KEY, "factories", "home", SidebarTab);
  refreshFactoryLists(environments);
}

/**
 * One line per environment that lists factories: its thread count and the attention its
 * factories' threads need here. Either changing means the server's counts may have moved.
 */
function factoryListsSignature(
  environments: ReadonlyArray<FactoryEnvironment>,
  threads: readonly EnvironmentThreadShell[],
  owned: ReadonlyMap<string, EnvironmentThreadShell>,
): ReadonlyArray<string> {
  return environments.flatMap(({ environmentId, factories }) => {
    if (factories === null) return [];
    const threadCount = threads.filter((thread) => thread.environmentId === environmentId).length;
    const attention = countThreadAttention(
      [...owned.values()].filter((thread) => thread.environmentId === environmentId),
    );
    return [`${environmentId}\t${threadCount}\t${attention}`];
  });
}

/** The sidebar's Home and Factories split: which threads stay in Home and each tab's badge. */
export function useSidebarFactories(threads: readonly EnvironmentThreadShell[]) {
  const environments = useFactoryEnvironments();
  const [storedTab, setStoredTab] = useLocalStorage<SidebarTab, SidebarTab>(
    SIDEBAR_TAB_KEY,
    "home",
    SidebarTab,
  );
  const { home, owned } = partitionFactoryThreads(threads, factoryOwnedThreadKeys(environments));
  const signature = factoryListsSignature(environments, threads, owned).join("\n");
  const seenSignature = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads an environment's factory list from the server when its threads come or go or an owned thread's attention moves, because the server pushes no factory updates
  useEffect(() => {
    const previous = seenSignature.current;
    seenSignature.current = signature;
    if (previous === null || previous === signature) return;
    const unchanged = new Set(previous.split("\n"));
    for (const line of signature.split("\n")) {
      if (line === "" || unchanged.has(line)) continue;
      factoriesEnvironment.refresh(
        appAtomRegistry,
        EnvironmentId.make(line.slice(0, line.indexOf("\t"))),
      );
    }
  }, [seenSignature, signature]);
  const showTabs = showsFactoriesTab(environments);
  return {
    environments,
    showTabs,
    tab: showTabs ? storedTab : ("home" as const),
    selectTab: (tab: SidebarTab) => {
      setStoredTab(tab);
      if (tab === "factories") refreshFactoryLists(environments);
    },
    homeThreads: home,
    ownedThreads: owned,
    homeAttention: countThreadAttention(home),
    factoriesAttention: factoriesAttentionTotal(environments),
  };
}
