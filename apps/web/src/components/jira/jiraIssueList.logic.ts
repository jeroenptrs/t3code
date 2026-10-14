/**
 * Fork-only. The `/issues` page's pure parts: grouping, facets, paging, the remembered view, and
 * what "Start thread from issue" writes into the composer.
 */
import type {
  BranchNamingOptions,
  JiraCapabilities,
  JiraPersonalCredential,
  JiraFilterView,
  JiraIssueSummary,
  JiraSearchResult,
  JiraSprintState,
  JiraStatusCategory,
} from "@t3tools/contracts";
import { formatGeneratedBranchName } from "@t3tools/shared/git";

/** Always this order, whatever the workflow calls its statuses. */
export const JIRA_STATUS_CATEGORY_ORDER: ReadonlyArray<JiraStatusCategory> = [
  "todo",
  "in-progress",
  "done",
];

export interface JiraIssueGroup {
  readonly category: JiraStatusCategory;
  readonly issues: ReadonlyArray<JiraIssueSummary>;
}

/** Every category, in order, each keeping the search's own order; empty ones included. */
export function groupJiraIssuesByStatusCategory(
  issues: ReadonlyArray<JiraIssueSummary>,
): ReadonlyArray<JiraIssueGroup> {
  return JIRA_STATUS_CATEGORY_ORDER.map((category) => ({
    category,
    issues: issues.filter((issue) => issue.statusCategory === category),
  }));
}

/** Pages in load order as one list. A row that moved between pages while paging shows once. */
export function mergeJiraSearchPages(pages: ReadonlyArray<JiraSearchResult>): {
  readonly issues: ReadonlyArray<JiraIssueSummary>;
  readonly nextPageToken: string | null;
} {
  const seen = new Set<string>();
  const issues: JiraIssueSummary[] = [];
  for (const page of pages) {
    for (const issue of page.issues) {
      const id = `${issue.site}/${issue.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      issues.push(issue);
    }
  }
  return { issues, nextPageToken: pages.at(-1)?.nextPageToken ?? null };
}

/** Starred first, then by name. */
export function sortJiraFilterViews(
  filters: ReadonlyArray<JiraFilterView>,
): ReadonlyArray<JiraFilterView> {
  return filters.toSorted(
    (left, right) =>
      Number(right.favourite) - Number(left.favourite) ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
}

/**
 * The caller's personal token, only when reads of `site` go out as them. The server uses it on the
 * credential's own site and reads every other site as the reader.
 */
export function personalCredentialForSite(
  capabilities: Pick<JiraCapabilities, "personalCredential">,
  site: string | null | undefined,
): JiraPersonalCredential | null {
  const credential = capabilities.personalCredential;
  return credential !== null && site != null && credential.site.toLowerCase() === site.toLowerCase()
    ? credential
    : null;
}

export type JiraIssueFacetKey = "assignee" | "priority" | "issueType" | "sprint" | "status";

const FACET_KEYS: ReadonlyArray<JiraIssueFacetKey> = [
  "assignee",
  "priority",
  "issueType",
  "sprint",
  "status",
];

/** The value an issue without an assignee, priority, type or sprint carries; no real one is empty. */
export const JIRA_FACET_NONE = "";

const NONE_LABEL: Record<JiraIssueFacetKey, string> = {
  assignee: "Unassigned",
  priority: "No priority",
  issueType: "No type",
  sprint: "No sprint",
  status: "No status",
};

export interface JiraIssueFacetOption {
  readonly value: string;
  readonly label: string;
  readonly count: number;
  readonly avatarUrl: string | null;
}

export type JiraIssueFacets = Record<JiraIssueFacetKey, ReadonlyArray<JiraIssueFacetOption>>;
export type JiraIssueFacetSelection = Record<JiraIssueFacetKey, ReadonlyArray<string>>;

export const EMPTY_JIRA_FACET_SELECTION: JiraIssueFacetSelection = {
  assignee: [],
  priority: [],
  issueType: [],
  sprint: [],
  status: [],
};

const SPRINT_STATE_RANK: Record<JiraSprintState, number> = { active: 0, future: 1, closed: 2 };

interface FacetEntry {
  readonly value: string;
  readonly label: string;
  readonly avatarUrl: string | null;
  /** Where a value sorts among its kind, for facets that run in a fixed order instead of by count. */
  readonly rank?: number;
}

/** What an issue offers a facet. Only sprint can offer several: an issue may sit in more than one. */
function facetEntries(issue: JiraIssueSummary, key: JiraIssueFacetKey): ReadonlyArray<FacetEntry> {
  switch (key) {
    case "assignee":
      return [
        issue.assignee === null
          ? { value: JIRA_FACET_NONE, label: NONE_LABEL.assignee, avatarUrl: null }
          : {
              value: issue.assignee.accountId,
              label: issue.assignee.displayName,
              avatarUrl: issue.assignee.avatarUrl,
            },
      ];
    case "priority":
      return [
        {
          value: issue.priority ?? JIRA_FACET_NONE,
          label: issue.priority ?? NONE_LABEL.priority,
          avatarUrl: null,
        },
      ];
    case "issueType":
      return [
        {
          value: issue.issueType ?? JIRA_FACET_NONE,
          label: issue.issueType ?? NONE_LABEL.issueType,
          avatarUrl: null,
        },
      ];
    case "sprint":
      return issue.sprints.length === 0
        ? [{ value: JIRA_FACET_NONE, label: NONE_LABEL.sprint, avatarUrl: null }]
        : issue.sprints.map((sprint) => ({
            value: String(sprint.id),
            label: sprint.name,
            avatarUrl: null,
            rank: SPRINT_STATE_RANK[sprint.state],
          }));
    case "status":
      return [
        {
          value: issue.status,
          label: issue.status,
          avatarUrl: null,
          rank: JIRA_STATUS_CATEGORY_ORDER.indexOf(issue.statusCategory),
        },
      ];
  }
}

function compareByName(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

/**
 * The choices each facet offers over the loaded rows, most common first and "none" last; sprints
 * run active, future, closed, then by name, and statuses by category then name. A value still selected but no longer among the rows
 * stays listed with a zero count, so it can be cleared.
 */
export function collectJiraIssueFacets(
  issues: ReadonlyArray<JiraIssueSummary>,
  selection: JiraIssueFacetSelection = EMPTY_JIRA_FACET_SELECTION,
): JiraIssueFacets {
  const collect = (key: JiraIssueFacetKey): ReadonlyArray<JiraIssueFacetOption> => {
    const byValue = new Map<
      string,
      { label: string; avatarUrl: string | null; count: number; rank?: number }
    >();
    for (const issue of issues) {
      for (const entry of facetEntries(issue, key)) {
        const current = byValue.get(entry.value);
        if (current) current.count += 1;
        else {
          byValue.set(entry.value, {
            label: entry.label,
            avatarUrl: entry.avatarUrl,
            count: 1,
            ...(entry.rank === undefined ? {} : { rank: entry.rank }),
          });
        }
      }
    }
    for (const value of selection[key]) {
      if (!byValue.has(value)) {
        byValue.set(value, {
          label: value === JIRA_FACET_NONE ? NONE_LABEL[key] : value,
          avatarUrl: null,
          count: 0,
        });
      }
    }
    return [...byValue.entries()]
      .map(([value, entry]) => ({ value, ...entry }))
      .toSorted((left, right) => {
        const none =
          Number(left.value === JIRA_FACET_NONE) - Number(right.value === JIRA_FACET_NONE);
        if (none !== 0) return none;
        if (key === "sprint" || key === "status") {
          return (
            (left.rank ?? Infinity) - (right.rank ?? Infinity) ||
            compareByName(left.label, right.label)
          );
        }
        return right.count - left.count || compareByName(left.label, right.label);
      })
      .map(({ value, label, count, avatarUrl }) => ({ value, label, count, avatarUrl }));
  };
  return {
    assignee: collect("assignee"),
    priority: collect("priority"),
    issueType: collect("issueType"),
    sprint: collect("sprint"),
    status: collect("status"),
  };
}

/**
 * Values within a facet are alternatives (an issue in several sprints matches any of them); facets
 * narrow each other. An empty facet is off.
 */
export function matchesJiraIssueFacets(
  issue: JiraIssueSummary,
  selection: JiraIssueFacetSelection,
): boolean {
  return FACET_KEYS.every(
    (key) =>
      selection[key].length === 0 ||
      facetEntries(issue, key).some((entry) => selection[key].includes(entry.value)),
  );
}

export function countJiraFacetSelection(selection: JiraIssueFacetSelection): number {
  return FACET_KEYS.reduce((total, key) => total + selection[key].length, 0);
}

/**
 * A branch name carrying the key, named the way the project names branches. Custom naming hands
 * a model free-form instructions, which a key and summary cannot follow, so it gets the plain
 * sanitized name. Sanitizing lowercases the key; the server matches keys case-insensitively and
 * takes the leftmost, so the key leads the last path segment and a `/` in the summary does not
 * start a new one.
 */
export function proposeJiraIssueBranchName(
  issue: Pick<JiraIssueSummary, "key" | "summary">,
  naming: BranchNamingOptions,
): string {
  const raw = `${issue.key}-${issue.summary.replaceAll("/", " ")}`;
  return formatGeneratedBranchName(raw, naming.mode === "custom" ? undefined : naming);
}

/**
 * `name`, or `name-2`, `name-3`, ... for the first one no local branch has. Starting from the same
 * issue twice must not hand `git worktree add -b` a branch that already exists.
 */
export function availableBranchName(name: string, takenBranchNames: ReadonlySet<string>): string {
  if (!takenBranchNames.has(name)) return name;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${name}-${suffix}`;
    if (!takenBranchNames.has(candidate)) return candidate;
  }
}

/**
 * The composer text for a thread started from an issue: `KEY: summary`, the description, the
 * browse URL, then the proposed branch. A new worktree's branch rides on the draft itself (shown
 * and clearable in the branch toolbar); the last line is only a hint for a thread that runs in the
 * project checkout, where nothing else names the branch. It does not create or switch anything.
 */
export function jiraIssueThreadPrompt(
  issue: Pick<JiraIssueSummary, "key" | "summary" | "url"> & {
    readonly description: string | null;
  },
  branch: string | null,
): string {
  const description = issue.description?.trim() ?? "";
  return [
    `${issue.key}: ${issue.summary}`,
    ...(description.length > 0 ? [description] : []),
    issue.url,
    ...(branch === null ? [] : [`Suggested branch if this thread runs locally: \`${branch}\``]),
  ].join("\n\n");
}

type ViewStorage = Pick<Storage, "getItem" | "setItem">;

const JIRA_ISSUES_VIEW_STORAGE_KEY = "t3.jiraIssues.views";
const MAX_FILTER_ID_LENGTH = 40;

function resolveViewStorage(storage: ViewStorage | undefined): ViewStorage | undefined {
  return storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
}

function readViewRecord(storage: ViewStorage | undefined): Record<string, string> {
  try {
    const raw = resolveViewStorage(storage)?.getItem(JIRA_ISSUES_VIEW_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" &&
          entry[1].length > 0 &&
          entry[1].length <= MAX_FILTER_ID_LENGTH,
      ),
    );
  } catch {
    return {};
  }
}

/** The filter the page last showed on this environment, so it reopens on it. */
export function readJiraIssuesViewId(environmentId: string, storage?: ViewStorage): string | null {
  return readViewRecord(storage)[environmentId] ?? null;
}

export function writeJiraIssuesViewId(
  environmentId: string,
  filterId: string,
  storage?: ViewStorage,
): void {
  const target = resolveViewStorage(storage);
  if (!target) return;
  try {
    target.setItem(
      JIRA_ISSUES_VIEW_STORAGE_KEY,
      JSON.stringify({ ...readViewRecord(target), [environmentId]: filterId }),
    );
  } catch {
    // Storage full or blocked: the page still works, it just will not remember the view.
  }
}
