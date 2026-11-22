import { projectChangeRequestUrl } from "@t3tools/client-runtime/change-request-links";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { openThreadDiffWalkthrough, useDiffPanelStore } from "../../diffPanelStore";
import { useOpenPullRequestWalkthrough } from "../../lib/openPullRequestLink";
import {
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import {
  readThreadShell,
  useAllEnvironmentShellsBootstrapped,
  useProjects,
} from "../../state/entities";
import { isThreadRoutePathname } from "../../threadRoutes";
import {
  readThreadWalkthroughLink,
  resolveOpenWalkthroughTarget,
  shownThreadWalkthroughLink,
  threadWalkthroughLinkKey,
  withThreadWalkthroughLink,
  type ThreadWalkthroughLink as Link,
} from "./openWalkthrough.logic";

/**
 * Keeps `?walkthrough` in a thread's URL naming the walkthrough its right panel shows, and opens
 * the one a link names. Mount it keyed by thread, so a new thread starts from its own URL.
 */
export function ThreadWalkthroughLink({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const location = useLocation({
    select: (current) => ({ pathname: current.pathname, search: current.searchStr }),
    structuralSharing: true,
  });
  const projects = useProjects();
  const projectsKnown = useAllEnvironmentShellsBootstrapped();
  const openPullRequestWalkthrough = useOpenPullRequestWalkthrough();
  const activeSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, threadRef),
  );
  const maximized = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).maximized === true,
  );
  const diffView = useDiffPanelStore((state) => state.view);
  const pullRequestProject =
    activeSurface?.kind === "pull-request"
      ? projects.find(
          (project) =>
            project.id === activeSurface.projectId &&
            project.environmentId === (activeSurface.environmentId ?? threadRef.environmentId),
        )
      : undefined;
  // The canonical URL, so a link carries no anchor the panel would reveal again.
  const pullRequestUrl =
    activeSurface?.kind === "pull-request"
      ? (projectChangeRequestUrl(
          pullRequestProject?.repositoryIdentity,
          activeSurface.repository,
          activeSurface.number,
        ) ??
        activeSurface.url ??
        null)
      : null;
  const shown = shownThreadWalkthroughLink({
    activeSurface,
    diffView,
    pullRequestUrl,
    maximized,
  });
  const shownKey = threadWalkthroughLinkKey(shown);
  // The last URL value the panel and the URL agreed on. A different one came from a link.
  const synced = useRef<string | null>(null);

  const open = (link: Link): "opened" | "pending" => {
    let target = link.walkthrough;
    if (target !== "diff" && !URL.canParse(target)) {
      const thread = readThreadShell(threadRef);
      if (thread === null) return "pending";
      const resolved = resolveOpenWalkthroughTarget(thread);
      target = resolved.kind === "pull-request" ? resolved.url : "diff";
    }
    if (target !== "diff" && !openPullRequestWalkthrough(threadRef, target)) {
      // Projects still loading may yet resolve it; once they are in, the diff stands in.
      if (!projectsKnown) return "pending";
      target = "diff";
    }
    if (target === "diff") openThreadDiffWalkthrough(threadRef);
    if (link.expanded) useRightPanelStore.getState().setMaximized(threadRef, true);
    return "opened";
  };

  // Takes what changed as arguments; `open` reads `projectsKnown` too, since a link to a pull
  // request waits for the projects that resolve it.
  const sync = useEffectEvent(
    (pathname: string, search: string, shownKey: string, _projectsKnown: boolean) => {
      // A pending navigation shows the next location while the params still name this thread.
      if (!isThreadRoutePathname(pathname, threadRef)) return;
      const asked = readThreadWalkthroughLink(search);
      const askedKey = threadWalkthroughLinkKey(asked);
      if (askedKey === shownKey) {
        synced.current = askedKey;
        return;
      }
      if (asked !== null && askedKey !== synced.current) {
        if (open(asked) === "opened") synced.current = askedKey;
        return;
      }
      synced.current = shownKey;
      void navigate({
        href: `${pathname}${withThreadWalkthroughLink(search, shown)}`,
        replace: true,
      });
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the shown walkthrough into the router URL, and opens the one a link names
  useEffect(
    () => sync(location.pathname, location.search, shownKey, projectsKnown),
    [location.pathname, location.search, projectsKnown, shownKey],
  );

  return null;
}
