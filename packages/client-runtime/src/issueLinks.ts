import {
  IssueTrackerKind,
  JIRA_ISSUE_TRACKER_KIND,
  issueTrackerBindingScopes,
  parseJiraIssueUrl,
  type IssueRef,
  type IssueTrackerConnectionList,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import {
  LINEAR_HOST,
  LINEAR_KIND,
  parseLinearIssueUrl,
} from "@t3tools/issue-tracker-linear/shared/issueUrl";

import { sourceControlClients } from "./sourceControlClients.ts";
import type { EnvironmentProject } from "./state/shell.ts";

type LinkProject = Pick<EnvironmentProject, "id" | "environmentId" | "repositoryIdentity">;

const issueBindingsByRepository = new WeakMap<
  RepositoryIdentity,
  ReturnType<typeof sourceControlClients.issueBindings>
>();

/** The hosts and scopes a project's git-host tracker is bound to, the way the server resolves them. */
function projectIssueBindings(project: LinkProject) {
  const identity = project.repositoryIdentity;
  if (identity == null) return [];
  const cached = issueBindingsByRepository.get(identity);
  if (cached !== undefined) return cached;
  const bindings = sourceControlClients
    .issueBindings(identity)
    .map((binding) => ({ ...binding, scope: binding.scope.toLowerCase() }));
  issueBindingsByRepository.set(identity, bindings);
  return bindings;
}

function linkAuthority(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** A host whose hostname does not name it, such as GitHub Enterprise Server, is vouched for by a project on it. */
function parseIssueLink(
  url: string,
  authority: string | null,
  projects: ReadonlyArray<LinkProject>,
) {
  const parsed = sourceControlClients.parseIssueUrl(url);
  if (parsed !== null || authority === null) return parsed;
  const hostname = new URL(url).hostname.toLowerCase();
  for (const project of projects) {
    const bindings = projectIssueBindings(project);
    if (!bindings.some((binding) => binding.host === hostname || binding.host === authority))
      continue;
    const known = sourceControlClients.parseIssueUrl(url, project.repositoryIdentity?.provider);
    if (known !== null) return known;
  }
  return null;
}

function parseStandaloneIssueLink(url: string, trackers?: IssueTrackerConnectionList) {
  try {
    const parsed = new URL(url);
    const link = parseLinearIssueUrl(parsed);
    if (link !== null) return { tracker: LINEAR_KIND, link };
    // Fork: Jira's site differs per server, so the tracker the server reports names it.
    for (const connection of trackers?.trackers ?? []) {
      if (connection.tracker !== JIRA_ISSUE_TRACKER_KIND) continue;
      const jira = parseJiraIssueUrl(parsed, connection.host);
      if (jira !== null) return { tracker: connection.tracker, link: jira };
    }
    return null;
  } catch {
    return null;
  }
}

/** Fork: a Jira issue URL on any site; which site is the server's is known only from its trackers. */
function looksLikeJiraIssueLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parseJiraIssueUrl(parsed, parsed.host) !== null;
  } catch {
    return false;
  }
}

/** Whether `url` is a standalone tracker's issue link, which only bindings can resolve. */
export function isStandaloneIssueLink(url: string): boolean {
  return parseStandaloneIssueLink(url) !== null || looksLikeJiraIssueLink(url);
}

/** A cheap pre-check, so text without such a link never asks for the bindings. */
export function mayContainStandaloneIssueLink(text: string): boolean {
  // Fork: `/browse/` is the path of every Jira issue URL.
  return text.includes(`${LINEAR_HOST}/`) || text.includes("/browse/");
}

/**
 * A standalone tracker link resolves through the project bound to its scope, else any bound to
 * the tracker, and only through an account whose credential reaches the workspace it names: team
 * keys repeat across workspaces, so a link elsewhere stays an ordinary link.
 */
function resolveStandaloneIssueLink<Project extends LinkProject>(
  url: string,
  projects: ReadonlyArray<Project>,
  trackers: IssueTrackerConnectionList | undefined,
  preferredProjectId: string | undefined,
): { readonly project: Project; readonly ref: IssueRef } | null {
  const parsed = trackers === undefined ? null : parseStandaloneIssueLink(url, trackers);
  if (parsed === null || trackers === undefined) return null;
  const { tracker, link } = parsed;
  const accounts = new Set(
    [...trackers.trackers, ...(trackers.accounts ?? [])]
      .filter(
        (connection) =>
          connection.tracker === tracker &&
          connection.account !== null &&
          connection.workspace?.toLowerCase() === link.workspace.toLowerCase(),
      )
      .map((connection) => connection.accountId ?? null),
  );
  if (accounts.size === 0) return null;
  const bindings = { ...trackers.bindings, ...trackers.accountBindings };
  const onTracker = projects.flatMap((project) => {
    const binding = bindings[project.id];
    return binding?.tracker === tracker && accounts.has(binding.accountId ?? null)
      ? [{ project, binding }]
      : [];
  });
  const preferFirst = (candidates: typeof onTracker) =>
    candidates.find((candidate) => candidate.project.id === preferredProjectId) ?? candidates[0];
  const scope = link.scope.toLowerCase();
  const boundScope = (candidate: (typeof onTracker)[number]) =>
    issueTrackerBindingScopes(candidate.binding).find((key) => key.toLowerCase() === scope);
  const own = preferFirst(onTracker.filter((candidate) => boundScope(candidate) !== undefined));
  const lender = own ?? preferFirst(onTracker);
  if (lender === undefined) return null;
  return {
    project: lender.project,
    ref: {
      projectId: lender.project.id,
      tracker: lender.binding.tracker,
      host: link.host,
      scope: (own && boundScope(own)) ?? link.scope,
      key: link.key,
    },
  };
}

/**
 * The reference an issue link resolves to, and the project it is read through: the project whose
 * tracker binding is that host and scope, else any project on the same tracker and host lending
 * its credentials for a read-only view. The same rule as the server's `IssueService.resolveUrl`,
 * applied on the client so a lookalike hostname matches no project and stays an ordinary link.
 */
export function resolveIssueLinkTarget<Project extends LinkProject>(input: {
  readonly url: string;
  /** The projects of the environment the link is read in. */
  readonly projects: ReadonlyArray<Project>;
  readonly preferredProjectId?: string | undefined;
  /** The environment's standalone trackers and bindings; without them only git-host links resolve. */
  readonly trackers?: IssueTrackerConnectionList | undefined;
}): { readonly project: Project; readonly ref: IssueRef } | null {
  // A link names its server's port; a binding does only when its remote or web URL did.
  const authority = linkAuthority(input.url);
  const parsed = parseIssueLink(input.url, authority, input.projects);
  if (parsed === null)
    return resolveStandaloneIssueLink(
      input.url,
      input.projects,
      input.trackers,
      input.preferredProjectId,
    );
  const { definition, link } = parsed;
  const onHost = input.projects.flatMap((project) =>
    projectIssueBindings(project)
      .filter(
        (binding) =>
          binding.tracker === definition.kind &&
          (binding.host === link.host || binding.host === authority),
      )
      .map((binding) => ({ project, binding })),
  );
  const onAuthority = onHost.filter((candidate) => candidate.binding.host === authority);
  const bound = onAuthority.length > 0 ? onAuthority : onHost;
  const preferFirst = (candidates: typeof bound) =>
    candidates.find((candidate) => candidate.project.id === input.preferredProjectId) ??
    candidates[0];
  const own =
    preferFirst(bound.filter((candidate) => candidate.binding.scope === link.scope)) ??
    preferFirst(bound.filter((candidate) => candidate.binding.scope === link.scopeAlias));
  const lender = own ?? preferFirst(bound);
  if (lender === undefined) return null;
  return {
    project: lender.project,
    ref: {
      projectId: lender.project.id,
      tracker: IssueTrackerKind.make(lender.binding.tracker),
      host: lender.binding.host,
      scope: own === undefined ? link.scope : lender.binding.scope,
      key: link.key,
    },
  };
}
