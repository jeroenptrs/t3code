import type {
  DiffWalkthroughBranchRangeIdentity,
  DiffWalkthroughPullRequestIdentity,
  EnvironmentId,
  PullRequestDetailView,
  PullRequestRef,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef, type Ref } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { createPullRequestDiffFileContentsLoader } from "~/lib/diffFileContents";
import { buildFileDiffRenderKey, resolveFileDiffPath } from "~/lib/diffRendering";
import { diffWalkthroughAtom } from "~/state/diffWalkthrough";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  DiffWalkthroughView,
  type DiffWalkthroughViewedFiles,
  type DiffWalkthroughViewFiles,
  type DiffWalkthroughViewHandle,
  type DiffWalkthroughViewSource,
} from "../diffs/DiffWalkthroughView";
import {
  diffWalkthroughStaleNotice,
  pickPullRequestWalkthrough,
} from "../diffs/diffWalkthroughView.logic";
import { pullRequestReviewKey } from "./pullRequestReviewStore";
import { usePullRequestDiffSlices } from "./usePullRequestDiffSlices";
import { usePullRequestFilesViewed } from "./usePullRequestFilesViewed";

/**
 * The pull request's walkthrough beside its whole diff, a section at a time. Opening it reads
 * what is stored and never starts an agent; Generate does, from the empty or stale state.
 */
function PullRequestWalkthroughTab({
  environmentId,
  reference,
  detail,
  onGenerate,
  generatePending,
  handleRef,
  scrollerRef,
  refreshToken = 0,
}: {
  scrollerRef: (node: HTMLDivElement | null) => void;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  /** Hands the walkthrough request to an agent. Absent where this client cannot start one. */
  onGenerate?: (() => void) | undefined;
  generatePending: boolean;
  handleRef?: Ref<DiffWalkthroughViewHandle>;
  /** Bumped by the panel's refresh button: drop the accumulated pages and re-read the diff. */
  refreshToken?: number;
}) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const liveHeadSha = detail.headSha ?? null;

  const pullRequestTarget = useMemo<DiffWalkthroughPullRequestIdentity>(
    () => ({
      kind: "pull-request",
      projectId: reference.projectId,
      ...(reference.host === undefined ? {} : { host: reference.host }),
      repository: reference.repository,
      number: reference.number,
    }),
    [reference.host, reference.number, reference.projectId, reference.repository],
  );
  const pullRequestQuery = useEnvironmentQuery(
    useMemo(
      () => diffWalkthroughAtom(environmentId, pullRequestTarget),
      [environmentId, pullRequestTarget],
    ),
  );
  const stored = pullRequestQuery.data?.walkthrough ?? null;
  // The head branch's own walkthrough is read only once the pull request is known to have none,
  // and only with a head to match it against.
  const branchTarget = useMemo<DiffWalkthroughBranchRangeIdentity | null>(
    () =>
      pullRequestQuery.data !== null && stored === null && liveHeadSha !== null
        ? { kind: "branch-range", projectId: reference.projectId, branch: detail.headBranch }
        : null,
    [detail.headBranch, liveHeadSha, pullRequestQuery.data, reference.projectId, stored],
  );
  const branchQuery = useEnvironmentQuery(
    useMemo(
      () => (branchTarget === null ? null : diffWalkthroughAtom(environmentId, branchTarget)),
      [branchTarget, environmentId],
    ),
  );

  const source = useMemo<DiffWalkthroughViewSource>(() => {
    if (pullRequestQuery.data === null) {
      return pullRequestQuery.error === null
        ? { kind: "loading" }
        : { kind: "error", message: pullRequestQuery.error };
    }
    if (branchTarget !== null && branchQuery.data === null) {
      // A failed fallback read leaves the pull request with what it has of its own: nothing.
      return branchQuery.error === null ? { kind: "loading" } : { kind: "empty" };
    }
    const walkthrough = pickPullRequestWalkthrough(
      stored,
      branchQuery.data?.walkthrough ?? null,
      liveHeadSha,
    );
    if (walkthrough === null) return { kind: "empty" };
    // A branch walkthrough is only shown at the head it was written for, so it is current.
    const staleNotice =
      walkthrough.target.kind === "pull-request" && liveHeadSha !== null
        ? diffWalkthroughStaleNotice(walkthrough, { ...pullRequestTarget, headSha: liveHeadSha })
        : null;
    return { kind: "ready", walkthrough, staleNotice };
  }, [
    branchQuery.data,
    branchQuery.error,
    branchTarget,
    liveHeadSha,
    pullRequestQuery.data,
    pullRequestQuery.error,
    pullRequestTarget,
    stored,
  ]);

  // The same slices the Code tab reads, so whichever tab opens second reuses the other's pages.
  const {
    scopeKey,
    diffQuery,
    loadedSlices,
    files: diffFiles,
    fileStat,
    nextCursor,
    canLoadNextSlice,
    loadNextSlice,
    restart: restartDiff,
  } = usePullRequestDiffSlices({
    environmentId,
    reference,
    commit: null,
    ignoreWhitespace: settings.diffIgnoreWhitespace,
    resolvedTheme,
  });
  // Sections are numbered against every changed file, so with a walkthrough to show the whole
  // diff is read, a slice after the other. Without one there is nothing to number.
  const walkthroughReady = source.kind === "ready";
  useEffect(() => {
    if (walkthroughReady && canLoadNextSlice) loadNextSlice();
  }, [canLoadNextSlice, loadNextSlice, walkthroughReady]);

  const filePaths = useMemo(() => diffFiles.map((file) => resolveFileDiffPath(file)), [diffFiles]);
  const filesViewed = usePullRequestFilesViewed({
    environmentId,
    reference,
    enabled: detail.capabilities.viewedFiles !== undefined,
    paths: filePaths,
  });
  const { enabled: viewedEnabled, isViewed, isStale, setViewed } = filesViewed;
  const viewed = useMemo<DiffWalkthroughViewedFiles | null>(
    () => (viewedEnabled ? { isViewed, isStale, setViewed } : null),
    [isStale, isViewed, setViewed, viewedEnabled],
  );

  const appliedRefreshToken = useRef(refreshToken);
  const refreshFilesViewed = filesViewed.refresh;
  useEffect(() => {
    if (appliedRefreshToken.current === refreshToken) return;
    appliedRefreshToken.current = refreshToken;
    restartDiff();
    refreshFilesViewed();
  }, [refreshToken, restartDiff, refreshFilesViewed]);

  const { error: diffError, refresh: refreshDiff } = diffQuery;
  const files = useMemo<DiffWalkthroughViewFiles>(() => {
    if (diffError !== null && (loadedSlices.length === 0 || nextCursor !== null)) {
      return { kind: "error", message: diffError, onRetry: () => refreshDiff() };
    }
    if (loadedSlices.length === 0 || nextCursor !== null) {
      return {
        kind: "loading",
        label:
          loadedSlices.length === 0
            ? "Loading pull request diff..."
            : `Loading pull request diff (${diffFiles.length} of ${detail.changedFiles} files)...`,
      };
    }
    return {
      kind: "ready",
      files: diffFiles.map((fileDiff) => ({
        key: buildFileDiffRenderKey(fileDiff),
        path: resolveFileDiffPath(fileDiff),
        fileDiff,
        ...fileStat(fileDiff),
      })),
    };
  }, [
    detail.changedFiles,
    diffError,
    diffFiles,
    fileStat,
    loadedSlices.length,
    nextCursor,
    refreshDiff,
  ]);

  const getDiffFileContents = useAtomCommand(pullRequestEnvironment.diffFileContents);
  const referenceKey = pullRequestReviewKey(reference);
  const loadDiffFiles = useMemo(
    () =>
      createPullRequestDiffFileContentsLoader(getDiffFileContents, {
        environmentId,
        reference,
        commit: null,
        cacheKey: `pull-request:${referenceKey}:${detail.updatedAt}:all`,
      }),
    [detail.updatedAt, environmentId, getDiffFileContents, reference, referenceKey],
  );

  return (
    <DiffWalkthroughView
      source={source}
      files={files}
      viewed={viewed}
      resetKey={scopeKey}
      onGenerate={onGenerate}
      generatePending={generatePending}
      emptyDescription="An agent can group this pull request's files by intent, in the order to read them, and say what each change is for."
      loadDiffFiles={loadDiffFiles}
      cwd={detail.workspaceRoot}
      environmentId={environmentId}
      scrollerRef={scrollerRef}
      {...(handleRef === undefined ? {} : { handleRef })}
    />
  );
}

export default PullRequestWalkthroughTab;
