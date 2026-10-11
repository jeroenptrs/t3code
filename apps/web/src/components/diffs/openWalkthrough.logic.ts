import type { ThreadLinkedPullRequest, ThreadPullRequestLink } from "@t3tools/contracts";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";

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
