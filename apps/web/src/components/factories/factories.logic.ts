import { FactoryName, type FactorySummary } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { FactoryEnvironment } from "../../state/factories";

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
  if (trimmed === "") return "Enter a name.";
  if (trimmed.length > 64) return "Use 64 characters or fewer.";
  if (!isFactoryName(trimmed)) {
    return "Use lowercase letters, digits, and single hyphens, such as nightly-triage.";
  }
  if (existing.some((factory) => factory.projectId === projectId && factory.name === trimmed)) {
    return "This project already has a factory with this name.";
  }
  return null;
}
