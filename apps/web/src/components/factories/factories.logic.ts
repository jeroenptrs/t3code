import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  FactoryName,
  type EnvironmentId,
  type FactorySummary,
  type Trigger,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { m } from "../../i18n/messages";
import type { FactoryEnvironment } from "../../state/factories";
import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";
import { triggerSummary } from "../settings/scheduledTasksSettings.logic";

const isFactoryName = Schema.is(FactoryName);

/**
 * The tab shows once an environment that answered the list holds a factory, or lets this user
 * make one. An environment that could not list factories (an upstream server) never shows it.
 */
export function showsFactoriesTab(environments: ReadonlyArray<FactoryEnvironment>): boolean {
  return environments.some(
    ({ factories, canManage }) => factories !== null && (factories.length > 0 || canManage),
  );
}

/**
 * The threads a factory lists: its runs, and threads its scheduled tasks start. A run's subagents
 * and side chats open inside the run, as they do everywhere else.
 */
export function factoryListedThreads<T extends EnvironmentThreadShell>(
  environmentId: EnvironmentId,
  factory: Pick<FactorySummary, "threadIds">,
  ownedThreads: ReadonlyMap<string, T>,
  delegatedUnderParent: ReadonlySet<string>,
): T[] {
  const owned = factory.threadIds.flatMap((threadId) => {
    const thread = ownedThreads.get(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
    return thread === undefined ? [] : [thread];
  });
  return filterSidebarV2VisibleThreads(owned, null, delegatedUnderParent);
}

export function factoriesAttentionTotal(environments: ReadonlyArray<FactoryEnvironment>): number {
  let total = 0;
  for (const { factories } of environments) {
    for (const factory of factories ?? []) total += factory.attention.total;
  }
  return total;
}

/**
 * Why a new factory's name cannot be saved, or null when it can. Saving an existing name would
 * replace that factory's definition, so a name the project already uses is refused here.
 */
export function factoryNameError(
  name: string,
  existing: ReadonlyArray<Pick<FactorySummary, "projectId" | "name">>,
  projectId: string | null,
): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return m(msg("Enter a name."));
  if (trimmed.length > 64) return m(msg("Use 64 characters or fewer."));
  if (!isFactoryName(trimmed)) {
    return m(msg("Use lowercase letters, digits, and single hyphens, such as nightly-triage."));
  }
  if (existing.some((factory) => factory.projectId === projectId && factory.name === trimmed)) {
    return m(msg("This project already has a factory with this name."));
  }
  return null;
}

/** A trigger's row under its factory: source and filters, then the factory or a thread. */
export function factoryTriggerSummary(
  trigger: Pick<Trigger, "source" | "filters" | "target">,
): string {
  const summary = triggerSummary(trigger);
  return trigger.target.type === "work_item" ? summary : `${summary} → thread`;
}

/** Home's Settled page sizes: the shelf opens on the newest ten and "show more" adds 25. */
export const SETTLED_SHELF_INITIAL_COUNT = 10;
export const SETTLED_SHELF_PAGE_COUNT = 25;

/**
 * The first `limit` threads of a Settled shelf, plus the open thread when it sits further down, as
 * Home keeps it. `hidden` counts the threads "show more" can still reveal.
 */
export function settledShelfRows<T extends Pick<EnvironmentThreadShell, "environmentId" | "id">>(
  threads: ReadonlyArray<T>,
  limit: number,
  routeRowThreadKey: string | null,
): { readonly shown: ReadonlyArray<T>; readonly hidden: number } {
  if (threads.length <= limit) return { shown: threads, hidden: 0 };
  const shown = threads.slice(0, limit);
  const route = threads
    .slice(limit)
    .find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeRowThreadKey,
    );
  return {
    shown: route === undefined ? shown : [...shown, route],
    hidden: threads.length - limit - (route === undefined ? 0 : 1),
  };
}
