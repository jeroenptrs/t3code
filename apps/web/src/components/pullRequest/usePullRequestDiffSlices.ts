import { useAtomRefresh } from "@effect/atom-react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, PullRequestOmittedFileStat, PullRequestRef } from "@t3tools/contracts";
import { useState } from "react";

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

export interface DiffSlice {
  readonly cursor: string | null;
  readonly patch: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly omittedFileStats: ReadonlyArray<PullRequestOmittedFileStat>;
}

const NO_SLICES: ReadonlyArray<DiffSlice> = [];

// Each slice is parsed once per cache key and the parse lives as long as the slice does, so a
// slice arriving costs one parse rather than one per slice already on screen.
const sliceParses = new WeakMap<DiffSlice, Map<string, RenderablePatch | null>>();

function parseSlice(slice: DiffSlice, cacheKey: string, ignoreWhitespace: boolean) {
  let parses = sliceParses.get(slice);
  if (parses === undefined) {
    parses = new Map();
    sliceParses.set(slice, parses);
  }
  if (parses.has(cacheKey)) return parses.get(cacheKey) ?? null;
  const parsed = getRenderablePatch(slice.patch, cacheKey, {
    compactPartialHunkOffsets: true,
    ignoreWhitespace,
  });
  parses.set(cacheKey, parsed);
  return parsed;
}

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
  const referenceKey = pullRequestReviewKey(reference);
  const scopeKey = JSON.stringify([environmentId, referenceKey, commit]);
  // Which pull request the slices belong to travels with them, so a render taken after the scope
  // changed cannot read the previous one's slices — or send its cursor to the host.
  const [sliceState, setSliceState] = useState<{
    readonly key: string;
    readonly cursor: string | null;
    readonly slices: ReadonlyArray<DiffSlice>;
  }>({ key: "", cursor: null, slices: NO_SLICES });

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
  // Pages accumulate into slices as each answer arrives, so the slice list is adjusted while
  // rendering the answer rather than one commit later.
  const [appliedPage, setAppliedPage] = useState<{
    readonly data: typeof diffQuery.data;
    readonly cursor: string | null;
    readonly scopeKey: string;
  } | null>(null);
  const data = diffQuery.data;
  if (
    data !== null &&
    (appliedPage?.data !== data ||
      appliedPage.cursor !== cursor ||
      appliedPage.scopeKey !== scopeKey)
  ) {
    setAppliedPage({ data, cursor, scopeKey });
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
  }
  const refreshFirstDiffPage = useAtomRefresh(
    pullRequestEnvironment.diff({
      environmentId,
      input: { ...reference, ...(commit === null ? {} : { commit }) },
    }),
  );
  /** Drop the accumulated slices and re-read the first, around the host's cache. */
  const restart = () => {
    setSliceState({ key: scopeKey, cursor: null, slices: NO_SLICES });
    refreshFirstDiffPage();
  };
  /**
   * Re-read from the first page but keep the slices mounted, which preserves scroll. The page
   * merge drops whatever changed.
   */
  const refresh = () => {
    setSliceState((previous) => ({ ...previous, cursor: null }));
    refreshFirstDiffPage();
  };

  // The cache key carries the theme, which is what the tokenizer caches against, so a theme
  // change is still a fresh parse. The patch's own hash is part of it too: a refreshed page
  // reuses its cursor, and a key of position alone would hand back the parse it replaced.
  const parsedSlices = loadedSlices.map((slice) =>
    parseSlice(
      slice,
      `pull-request:${scopeKey}:${resolvedTheme}:${ignoreWhitespace}:${slice.cursor ?? "first"}:${fnv1a32(slice.patch)}`,
      ignoreWhitespace,
    ),
  );
  const files = parsedSlices.flatMap((parsed) =>
    parsed?.kind === "files" ? orderDiffFiles(parsed.files) : [],
  );
  const filePaths = files.map((file) => resolveFileDiffPath(file));
  const omittedFileStats = new Map(
    loadedSlices.flatMap((slice) =>
      slice.omittedFileStats.map((file) => [file.path, file] as const),
    ),
  );
  const sourceFileStats = new Map(
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
  );
  /**
   * A file's counts as the host has them: from its unfiltered hunks, so hiding whitespace does
   * not shrink them, and from the host's own report for a file whose hunks it withheld.
   */
  const fileStat = (fileDiff: FileDiffMetadata): DiffLineStat => {
    const stat =
      sourceFileStats.get(buildFileDiffRenderKey(fileDiff)) ?? getDiffLineStat([fileDiff]);
    if (stat.additions !== 0 || stat.deletions !== 0) return stat;
    return omittedFileStats.get(resolveFileDiffPath(fileDiff)) ?? stat;
  };

  const nextCursor = loadedSlices.at(-1)?.nextCursor ?? null;
  // A failed slice must not be asked for again on its own. The files already loaded keep the
  // sentinel on screen, so re-arming it after a failure would request the same slice forever.
  const canLoadNextSlice =
    nextCursor !== null &&
    nextCursor !== cursor &&
    !diffQuery.isPending &&
    diffQuery.error === null;
  const loadNextSlice = () => {
    if (nextCursor === null) return;
    setSliceState((previous) => ({ ...previous, cursor: nextCursor }));
  };

  return {
    scopeKey,
    diffQuery,
    loadedSlices,
    parsedSlices,
    files,
    filePaths,
    fileStat,
    cursor,
    nextCursor,
    canLoadNextSlice,
    loadNextSlice,
    restart,
    refresh,
  };
}
