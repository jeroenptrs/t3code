import { useAtomRefresh } from "@effect/atom-react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, PullRequestOmittedFileStat, PullRequestRef } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildFileDiffRenderKey,
  fnv1a32,
  getDiffLineStat,
  getRenderablePatch,
  resolveFileDiffPath,
  type DiffLineStat,
  type RenderablePatch,
} from "~/lib/diffRendering";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { orderDiffFiles } from "./pullRequestFileOrder.logic";
import { pullRequestReviewKey } from "./pullRequestReviewStore";

/** One answer from the host: a whole number of files, and where the next one carries on. */
export interface DiffSlice {
  /** What was asked for, null being the first slice. Identifies the slice among the loaded ones. */
  readonly cursor: string | null;
  readonly patch: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly omittedFileStats: ReadonlyArray<PullRequestOmittedFileStat>;
}

/** Nothing loaded yet, as one identity, so the memos below do not see a new array every render. */
const NO_SLICES: ReadonlyArray<DiffSlice> = [];

/**
 * A pull request's diff, a slice at a time, parsed for the viewer. The Code and Walkthrough tabs
 * each hold one; the slices are read through the same query atoms, so whichever opens second
 * reuses what the first already read. The caller decides when the next slice is asked for.
 */
export function usePullRequestDiffSlices({
  environmentId,
  reference,
  commit,
  ignoreWhitespace,
  resolvedTheme,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  /** One commit's own changes, or null for the whole change. */
  readonly commit: string | null;
  readonly ignoreWhitespace: boolean;
  readonly resolvedTheme: string;
}) {
  // One commit's own changes and the whole change are two different diffs, paged separately, so
  // everything below is keyed by both.
  const referenceKey = pullRequestReviewKey(reference);
  const scopeKey = commit === null ? referenceKey : `${referenceKey}@${commit}`;
  // Which pull request the slices belong to travels with them, so a render taken before the
  // reset below cannot read the previous one's slices — or send its cursor to the host.
  const [sliceState, setSliceState] = useState<{
    readonly key: string;
    readonly cursor: string | null;
    readonly slices: ReadonlyArray<DiffSlice>;
  }>({ key: "", cursor: null, slices: NO_SLICES });
  const parseCache = useRef(new Map<string, RenderablePatch>());
  useEffect(() => {
    setSliceState({ key: scopeKey, cursor: null, slices: NO_SLICES });
    parseCache.current.clear();
  }, [scopeKey]);

  const loadedSlices = sliceState.key === scopeKey ? sliceState.slices : NO_SLICES;
  const cursor = sliceState.key === scopeKey ? sliceState.cursor : null;
  const diffQuery = useEnvironmentQuery(
    pullRequestEnvironment.diff({
      environmentId,
      input: {
        ...reference,
        ...(cursor === null ? {} : { cursor }),
        ...(commit === null ? {} : { commit }),
      },
    }),
  );
  // Each answer is kept as its own slice. Concatenating the patches and re-parsing the growing
  // text would cost more with every slice, which is the wall the slicing exists to remove.
  useEffect(() => {
    const data = diffQuery.data;
    if (data === null) return;
    setSliceState((previous) => {
      const slices = previous.key === scopeKey ? previous.slices : NO_SLICES;
      const next = {
        cursor,
        patch: data.patch,
        truncated: data.truncated,
        nextCursor: data.nextCursor,
        omittedFileStats: data.omittedFileStats ?? [],
      };
      const index = slices.findIndex((slice) => slice.cursor === cursor);
      if (index === -1) {
        return { key: scopeKey, cursor, slices: [...slices, next] };
      }
      const existing = slices[index];
      if (
        existing !== undefined &&
        existing.patch === next.patch &&
        existing.truncated === next.truncated &&
        existing.nextCursor === next.nextCursor &&
        existing.omittedFileStats.length === next.omittedFileStats.length &&
        existing.omittedFileStats.every((file, index) => {
          const refreshed = next.omittedFileStats[index];
          return (
            refreshed !== undefined &&
            refreshed.path === file.path &&
            refreshed.additions === file.additions &&
            refreshed.deletions === file.deletions
          );
        })
      ) {
        return previous;
      }
      // A page that came back different means the diff moved under the review. The slices
      // after it go with the replacement: their cursors were positions in the old diff.
      return { key: scopeKey, cursor, slices: [...slices.slice(0, index), next] };
    });
  }, [cursor, diffQuery.data, scopeKey]);
  // The refresh button rereads from the first page rather than the page the reader is on:
  // pages are positions in one snapshot of the diff, and a fresh snapshot starts over.
  const refreshFirstDiffPage = useAtomRefresh(
    pullRequestEnvironment.diff({
      environmentId,
      input: { ...reference, ...(commit === null ? {} : { commit }) },
    }),
  );
  const restart = useCallback(() => {
    setSliceState({ key: scopeKey, cursor: null, slices: NO_SLICES });
    refreshFirstDiffPage();
  }, [refreshFirstDiffPage, scopeKey]);

  // Every slice is parsed on its own and the result held, so a slice arriving costs one parse
  // rather than one per slice already on screen. Its cache key carries the theme, which is what
  // the tokenizer caches against, so a theme change is still a fresh parse.
  const parsedSlices = useMemo(
    () =>
      loadedSlices.map((slice) => {
        // The patch's own hash is part of the key: a refreshed page reuses its cursor, and a
        // key of position alone would keep handing back the parse of the patch it replaced.
        const cacheKey = `pull-request:${scopeKey}:${resolvedTheme}:${ignoreWhitespace}:${slice.cursor ?? "first"}:${fnv1a32(slice.patch)}`;
        const cached = parseCache.current.get(cacheKey);
        if (cached) return cached;
        const parsed = getRenderablePatch(slice.patch, cacheKey, {
          compactPartialHunkOffsets: true,
          ignoreWhitespace,
        });
        if (parsed) parseCache.current.set(cacheKey, parsed);
        return parsed;
      }),
    [loadedSlices, resolvedTheme, scopeKey, ignoreWhitespace],
  );
  // Ordered within a slice rather than across them: ordering the accumulated set would let a late
  // slice push a file the reader is part way through further down the page.
  const files = useMemo(
    () =>
      parsedSlices.flatMap((parsed) =>
        parsed?.kind === "files" ? orderDiffFiles(parsed.files) : [],
      ),
    [parsedSlices],
  );

  const omittedFileStats = useMemo(
    () =>
      new Map(
        loadedSlices.flatMap((slice) =>
          slice.omittedFileStats.map((file) => [file.path, file] as const),
        ),
      ),
    [loadedSlices],
  );
  const sourceFileStats = useMemo(
    () =>
      new Map(
        parsedSlices.flatMap((parsed) =>
          parsed?.kind === "files"
            ? parsed.files.map(
                (file, index) =>
                  [
                    buildFileDiffRenderKey(file),
                    getDiffLineStat([parsed.sourceFiles[index] ?? file]),
                  ] as const,
              )
            : [],
        ),
      ),
    [parsedSlices],
  );
  /**
   * A file's counts as the host has them: from its unfiltered hunks, so hiding whitespace does
   * not shrink them, and from the host's own report for a file whose hunks it withheld.
   */
  const fileStat = useCallback(
    (fileDiff: FileDiffMetadata): DiffLineStat => {
      const stat =
        sourceFileStats.get(buildFileDiffRenderKey(fileDiff)) ?? getDiffLineStat([fileDiff]);
      if (stat.additions !== 0 || stat.deletions !== 0) return stat;
      return omittedFileStats.get(resolveFileDiffPath(fileDiff)) ?? stat;
    },
    [omittedFileStats, sourceFileStats],
  );

  const nextCursor = loadedSlices.at(-1)?.nextCursor ?? null;
  // A failed slice must not be asked for again on its own. The files already loaded keep the
  // sentinel on screen, so re-arming it after a failure would request the same slice forever.
  const canLoadNextSlice =
    nextCursor !== null &&
    nextCursor !== cursor &&
    !diffQuery.isPending &&
    diffQuery.error === null;
  const loadNextSlice = useCallback(() => {
    if (nextCursor === null) return;
    setSliceState((previous) => ({ ...previous, cursor: nextCursor }));
  }, [nextCursor]);

  return {
    scopeKey,
    diffQuery,
    loadedSlices,
    parsedSlices,
    files,
    fileStat,
    cursor,
    nextCursor,
    canLoadNextSlice,
    loadNextSlice,
    /** Drop the accumulated slices and re-read the first, around the host's cache. */
    restart,
  };
}
