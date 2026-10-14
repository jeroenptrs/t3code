/**
 * Fork-only Jira read side. Every read goes through the server's reader identity; thread shells
 * carry only each linked issue's key, summary and status category, so lists render from those and
 * the detail query runs only where an issue is actually opened.
 */
import {
  JIRA_ISSUE_KEY_PATTERN,
  WS_METHODS,
  type EnvironmentId,
  type JiraCapabilities,
  type JiraIssueKey,
  type ThreadJiraIssueLink,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * The inputs whose next request skips the server's read cache. Only an explicit refresh marks
 * one, so stale-time revalidation and reconnects keep reading through the cache. A mark made
 * while disconnected goes out with the next request.
 */
function createJiraCacheSkips() {
  const marked = new Set<string>();
  return {
    mark: (input: unknown) => {
      marked.add(JSON.stringify(input));
    },
    take: (input: unknown) => marked.delete(JSON.stringify(input)),
  };
}

/**
 * Query atoms per environment. Capabilities change only when the server's configuration or the
 * caller's personal token does, so they are kept for five minutes; an issue is re-read after
 * thirty seconds when it is shown again. Nothing here polls.
 */
export function createJiraEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // Every read depends on who Jira is read as, which a personal token changes. Bumping this
  // re-reads whatever is mounted and marks the rest stale, so no read outlives the identity.
  const readerEpoch = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.withLabel("environment-data:jira:reader-epoch")),
  );
  const refreshTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    readerEpoch(environmentId);
  const readerChanged = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.update(readerEpoch(environmentId), (epoch) => epoch + 1));
  // Search and issue reads are cached briefly on the server; the refreshes below skip that cache.
  // They need no client grant, so the permission guard cannot refuse them.
  const searchSkips = createJiraCacheSkips();
  const search = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:jira:search",
    tag: WS_METHODS.jiraSearch,
    staleTimeMs: 30_000,
    refreshTrigger,
    execute: (input) =>
      request(
        WS_METHODS.jiraSearch,
        searchSkips.take(input) ? { ...input, refresh: true } : input,
      ).pipe(Effect.catchTags({ EnvironmentAuthorizationError: Effect.die })),
  });
  const issueSkips = createJiraCacheSkips();
  const issue = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:jira:issue",
    tag: WS_METHODS.jiraIssue,
    staleTimeMs: 30_000,
    refreshTrigger,
    execute: (input) =>
      request(
        WS_METHODS.jiraIssue,
        issueSkips.take(input) ? { ...input, refresh: true } : input,
      ).pipe(Effect.catchTags({ EnvironmentAuthorizationError: Effect.die })),
  });
  return {
    capabilities: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:jira:capabilities",
      tag: WS_METHODS.jiraCapabilities,
      staleTimeMs: 5 * 60_000,
      refreshTrigger,
    }),
    /** The reader's favourite and own filters, or those matching a name. */
    filters: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:jira:filters",
      tag: WS_METHODS.jiraFilters,
      staleTimeMs: 60_000,
      refreshTrigger,
    }),
    filter: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:jira:filter",
      tag: WS_METHODS.jiraFilter,
      staleTimeMs: 60_000,
      refreshTrigger,
    }),
    /** One page of a filter or ad-hoc JQL; pages are keyed by their `nextPageToken`. */
    search,
    /** Re-reads a page past the server's cache, for an explicit refresh. */
    refreshSearch: (registry: AtomRegistry.AtomRegistry, target: Parameters<typeof search>[0]) => {
      searchSkips.mark(target.input);
      registry.refresh(search(target));
    },
    issue,
    /** Re-reads an issue past the server's cache, for an explicit refresh. */
    refreshIssue: (registry: AtomRegistry.AtomRegistry, target: Parameters<typeof issue>[0]) => {
      issueSkips.mark(target.input);
      registry.refresh(issue(target));
    },
    /**
     * The caller's own token. Each success re-reads capabilities and every cached read, because
     * reads now go out as a different identity.
     */
    setPersonalToken: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:jira:set-personal-token",
      tag: WS_METHODS.jiraSetPersonalToken,
      onSuccess: (target, registry) => readerChanged(target, registry),
    }),
    testPersonalToken: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:jira:test-personal-token",
      tag: WS_METHODS.jiraTestPersonalToken,
      onSuccess: (target, registry) => readerChanged(target, registry),
    }),
    clearPersonalToken: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:jira:clear-personal-token",
      tag: WS_METHODS.jiraClearPersonalToken,
      onSuccess: (target, registry) => readerChanged(target, registry),
    }),
  };
}

export const JIRA_NOT_CONFIGURED: JiraCapabilities = {
  configured: false,
  identities: [],
  reader: null,
  viewer: null,
  readerError: null,
  personalTokens: false,
  personalCredential: null,
};

/**
 * What a surface should gate on: null until the server first answers, then its capabilities.
 * Any failure counts as not configured, which is also what a server too old to know `jira.*`
 * answers with. A failure after a success keeps the last answer, so a dropped connection does not
 * hide links the user was just looking at.
 */
export function resolveJiraCapabilities(
  result: AsyncResult.AsyncResult<JiraCapabilities, unknown>,
): JiraCapabilities | null {
  const value = Option.getOrNull(AsyncResult.value(result));
  if (value !== null) return value;
  return result._tag === "Failure" ? JIRA_NOT_CONFIGURED : null;
}

/** Links a client shows: `branch-dismissed` is a tombstone that keeps the detector from re-adding. */
export function visibleThreadJiraIssues(
  links: ReadonlyArray<ThreadJiraIssueLink> | undefined,
): ReadonlyArray<ThreadJiraIssueLink> {
  return (links ?? []).filter((link) => link.source !== "branch-dismissed");
}

/** A stable string identity for an issue, for React keys and comparisons. */
export function jiraIssueKeyOf(issue: JiraIssueKey): string {
  return `${issue.site.toLowerCase()}/${issue.key.toUpperCase()}`;
}

export function jiraIssueKeysEqual(left: JiraIssueKey, right: JiraIssueKey): boolean {
  return jiraIssueKeyOf(left) === jiraIssueKeyOf(right);
}

export function jiraIssueUrl(issue: JiraIssueKey): string {
  return `https://${issue.site}/browse/${issue.key}`;
}

function normalizeIssueKey(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  const key = candidate.trim().toUpperCase();
  return JIRA_ISSUE_KEY_PATTERN.test(key) ? key : null;
}

/**
 * The issue a user typed or pasted: a bare key such as `abc-123` on `defaultSite`, or a link to
 * the issue on any site (`/browse/ABC-123`, a board or project URL ending in `/issues/ABC-123`, or
 * one carrying `?selectedIssue=ABC-123`). Null when the text names no issue, or names a bare key
 * while there is no default site to put it on.
 */
export function parseJiraIssueInput(text: string, defaultSite: string | null): JiraIssueKey | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const bareKey = normalizeIssueKey(trimmed);
  if (bareKey !== null) {
    return defaultSite === null ? null : { site: defaultSite.toLowerCase(), key: bareKey };
  }
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const site = url.hostname.toLowerCase();
  if (!site.includes(".")) return null;
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const marker = segments.findLastIndex((segment) => segment === "browse" || segment === "issues");
  const key =
    normalizeIssueKey(url.searchParams.get("selectedIssue")) ??
    (marker === -1 ? null : normalizeIssueKey(segments[marker + 1]));
  return key === null ? null : { site, key };
}
