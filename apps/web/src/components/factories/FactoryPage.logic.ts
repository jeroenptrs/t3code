import {
  FactoryRoleName,
  ScheduledTaskId,
  WorkItemId,
  type Factory,
  type FactoryIssue,
  type FactoryRole,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { validateWorkItemSearch, type WorkItemSearch } from "./workItems.logic";

export const FACTORY_TABS = [
  "overview",
  "work-items",
  "roles",
  "skills",
  "triggers",
  "settings",
] as const;
export type FactoryTab = (typeof FACTORY_TABS)[number];

/** The factory page's address: the tab, the role page, the work item filters, the open item. */
export interface FactoryPageSearch extends WorkItemSearch {
  /** Absent is Overview, so a plain link to the factory lands there. */
  readonly tab?: Exclude<FactoryTab, "overview"> | undefined;
  readonly role?: FactoryRoleName | undefined;
  readonly item?: WorkItemId | undefined;
  /** A Jira query trigger whose matching issues the Triggers tab shows. */
  readonly trigger?: ScheduledTaskId | undefined;
}

const isTab = (value: unknown): value is Exclude<FactoryTab, "overview"> =>
  typeof value === "string" && value !== "overview" && FACTORY_TABS.some((tab) => tab === value);
const isRole = Schema.is(FactoryRoleName);
const isWorkItemId = Schema.is(WorkItemId);
const isScheduledTaskId = Schema.is(ScheduledTaskId);

/** Drops any param that is not a known value, so a stale link still opens the factory. */
export function validateFactoryPageSearch(raw: Record<string, unknown>): FactoryPageSearch {
  const tab = isTab(raw.tab) ? raw.tab : undefined;
  return {
    ...(tab === undefined ? {} : { tab }),
    ...(tab === "roles" && isRole(raw.role) ? { role: raw.role } : {}),
    ...(tab === "work-items" ? validateWorkItemSearch(raw) : {}),
    ...(tab === "work-items" && isWorkItemId(raw.item) ? { item: raw.item } : {}),
    ...(tab === "triggers" && isScheduledTaskId(raw.trigger) ? { trigger: raw.trigger } : {}),
  };
}

/** Where an issue shows: a role's on the Roles tab, the rest on Settings. */
export function issueTab(issue: FactoryIssue): FactoryTab {
  return issue.role !== null ? "roles" : "settings";
}

export function issueCountByTab(issues: ReadonlyArray<FactoryIssue>): Map<FactoryTab, number> {
  const counts = new Map<FactoryTab, number>();
  for (const issue of issues) {
    const tab = issueTab(issue);
    counts.set(tab, (counts.get(tab) ?? 0) + 1);
  }
  return counts;
}

/** The issues for one role, or for `factory.json` with a null role, optionally one field. */
export function issuesFor(
  issues: ReadonlyArray<FactoryIssue>,
  role: FactoryRoleName | null,
  field?: string | null,
): ReadonlyArray<FactoryIssue> {
  return issues.filter(
    (issue) => issue.role === role && (field === undefined || issue.field === field),
  );
}

export type FactoryStatus = "issues" | "attention" | "ok";

/** The header dot: a broken definition first, then work that waits on a person. */
export function factoryStatus(factory: Pick<Factory, "issues" | "attention">): FactoryStatus {
  if (factory.issues.length > 0) return "issues";
  return factory.attention.total > 0 ? "attention" : "ok";
}

export type FactoryRoleStatus = "issues" | "disabled" | "enabled";

export function factoryRoleStatus(
  role: Pick<FactoryRole, "role" | "enabled">,
  issues: ReadonlyArray<FactoryIssue>,
): FactoryRoleStatus {
  if (issuesFor(issues, role.role).length > 0) return "issues";
  return role.enabled ? "enabled" : "disabled";
}

/** The factory page's route, for links and navigation inside it. */
export const FACTORY_ROUTE = "/factories/$environmentId/$factoryId";
