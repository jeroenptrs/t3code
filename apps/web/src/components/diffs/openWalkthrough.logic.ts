import type {
  ScopedThreadRef,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import { hostedThreadLink } from "@t3tools/shared/threadLinks";

import type { DiffPanelView } from "../../diffPanelStore";
import type { RightPanelSurface } from "../../rightPanelStore";

export type OpenWalkthroughTarget =
  | { readonly kind: "pull-request"; readonly url: string }
  | { readonly kind: "thread-diff" };

/**
 * Where "Open walkthrough" takes a thread: the Walkthrough tab of the pull request its details
 * row shows, or, with none, the walkthrough of its own diff.
 */
export function resolveOpenWalkthroughTarget(thread: {
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  readonly branchPullRequest?: ThreadLinkedPullRequest | null | undefined;
}): OpenWalkthroughTarget {
  const url =
    resolveThreadCurrentPullRequestLink(thread.pullRequests ?? [])?.url ??
    thread.linkedPullRequest?.url ??
    thread.branchPullRequest?.url;
  return url ? { kind: "pull-request", url } : { kind: "thread-diff" };
}

/**
 * A walkthrough named in a thread's URL: `diff` for the thread's own, a pull request's URL for
 * its Walkthrough tab, or any other value for whatever "Open walkthrough" picks.
 */
export interface ThreadWalkthroughLink {
  readonly walkthrough: string;
  readonly expanded: boolean;
}

export function readThreadWalkthroughLink(search: string): ThreadWalkthroughLink | null {
  const params = new URLSearchParams(search);
  const walkthrough = params.get("walkthrough");
  if (walkthrough === null) return null;
  const expanded = params.get("expanded");
  return { walkthrough, expanded: expanded === "true" || expanded === "" };
}

/** The search string with `link` in place of whatever walkthrough it named, other params kept. */
export function withThreadWalkthroughLink(
  search: string,
  link: ThreadWalkthroughLink | null,
): string {
  const params = new URLSearchParams(search);
  params.delete("walkthrough");
  params.delete("expanded");
  if (link !== null) {
    params.set("walkthrough", link.walkthrough);
    if (link.expanded) params.set("expanded", "true");
  }
  const next = params.toString();
  return next === "" ? "" : `?${next}`;
}

export function threadWalkthroughLinkKey(link: ThreadWalkthroughLink | null): string {
  return link === null ? "" : `${link.walkthrough}\u0000${link.expanded}`;
}

/**
 * The walkthrough a thread's right panel shows, as its URL names it. A pull request without a
 * URL to name it by has no link.
 */
export function shownThreadWalkthroughLink(input: {
  readonly activeSurface: RightPanelSurface | null;
  readonly diffView: DiffPanelView;
  readonly pullRequestUrl: string | null;
  readonly maximized: boolean;
}): ThreadWalkthroughLink | null {
  const surface = input.activeSurface;
  const walkthrough =
    surface?.kind === "diff" && input.diffView === "walkthrough"
      ? "diff"
      : surface?.kind === "pull-request" && surface.detailTab === "walkthrough"
        ? input.pullRequestUrl
        : null;
  return walkthrough === null ? null : { walkthrough, expanded: input.maximized };
}

/**
 * The link "Copy link" hands out for the walkthrough on screen, read from the URL that already
 * names it. A thread's goes through the hosted app, which offers every client, as copied thread
 * links do.
 */
export function walkthroughShareUrl(input: {
  readonly href: string;
  readonly origin: string;
  readonly threadRef: ScopedThreadRef | null;
  readonly hostedAppUrl: string;
}): string {
  const url = new URL(input.href, input.origin);
  if (input.threadRef === null) return url.toString();
  return `${hostedThreadLink(input.threadRef, input.hostedAppUrl)}${url.search}`;
}
