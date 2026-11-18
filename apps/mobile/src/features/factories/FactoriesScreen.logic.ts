import type { EnvironmentId, FactorySummary, ProjectId } from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

export interface EnvironmentFactoryList {
  readonly environmentId: EnvironmentId;
  readonly factories: ReadonlyArray<FactorySummary>;
}

export interface FactoryListSection {
  readonly environmentId: EnvironmentId;
  /** Null while only one environment can report factories. */
  readonly title: string | null;
  readonly rows: ReadonlyArray<{
    readonly factory: FactorySummary;
    readonly projectTitle: string | null;
  }>;
}

export function factoryListSections(input: {
  readonly lists: ReadonlyArray<EnvironmentFactoryList>;
  readonly environmentLabel: (environmentId: EnvironmentId) => string;
  readonly projectTitle: (environmentId: EnvironmentId, projectId: ProjectId) => string | null;
}): ReadonlyArray<FactoryListSection> {
  const grouped = input.lists.length > 1;
  return input.lists
    .filter((list) => list.factories.length > 0)
    .map((list) => ({
      environmentId: list.environmentId,
      title: grouped ? input.environmentLabel(list.environmentId) : null,
      rows: list.factories.map((factory) => ({
        factory,
        projectTitle: input.projectTitle(list.environmentId, factory.projectId),
      })),
    }));
}

export function hasFactories(lists: ReadonlyArray<EnvironmentFactoryList>): boolean {
  return lists.some((list) => list.factories.length > 0);
}

export function factoryAttentionTotal(lists: ReadonlyArray<EnvironmentFactoryList>): number {
  let total = 0;
  for (const list of lists) for (const factory of list.factories) total += factory.attention.total;
  return total;
}

/** What waits on a person, or null when nothing does. */
export function describeFactoryAttention(
  attention: FactorySummary["attention"],
  resolve: MessageResolver = m,
): string | null {
  if (attention.total === 0) return null;
  return resolve(
    msg(
      "{gates, plural, one {{gates} gate waiting} other {{gates} gates waiting}}, {failed, plural, one {{failed} failed run} other {{failed} failed runs}}, {questions, plural, one {{questions} question} other {{questions} questions}}",
      {
        gates: attention.gatesWaiting,
        failed: attention.failedRuns,
        questions: attention.questions,
      },
    ),
  );
}
