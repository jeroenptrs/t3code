import {
  DIFF_WALKTHROUGH_OTHER_GROUP_ID,
  groupDiffWalkthroughFiles,
  isDiffWalkthroughStale,
  type DiffWalkthrough,
  type DiffWalkthroughNote,
  type DiffWalkthroughTarget,
} from "@t3tools/contracts";

export interface DiffWalkthroughRailNote {
  readonly key: string;
  readonly note: DiffWalkthroughNote;
}

export interface DiffWalkthroughRailFile {
  readonly key: string;
  readonly path: string;
  readonly notes: ReadonlyArray<DiffWalkthroughRailNote>;
}

export interface DiffWalkthroughRailGroup {
  readonly id: string;
  /** 1-based reading position; null for the trailing "Other" group. */
  readonly ordinal: number | null;
  readonly title: string;
  readonly summary: string;
  readonly files: ReadonlyArray<DiffWalkthroughRailFile>;
}

export interface DiffWalkthroughRailModel {
  readonly summary: string | null;
  readonly groups: ReadonlyArray<DiffWalkthroughRailGroup>;
}

const NO_NOTES: ReadonlyArray<DiffWalkthroughRailNote> = [];

export function diffWalkthroughFileKey(path: string): string {
  return `file:${path}`;
}

/**
 * Each note in the order the walkthrough lists it, under the file it is on. A note's key is its
 * index in the walkthrough, which is stable for as long as the walkthrough is.
 */
export function diffWalkthroughNotesByPath(
  walkthrough: Pick<DiffWalkthrough, "notes">,
): ReadonlyMap<string, ReadonlyArray<DiffWalkthroughRailNote>> {
  const byPath = new Map<string, DiffWalkthroughRailNote[]>();
  walkthrough.notes.forEach((note, index) => {
    const entry = { key: `note:${index}`, note };
    const existing = byPath.get(note.path);
    if (existing === undefined) byPath.set(note.path, [entry]);
    else existing.push(entry);
  });
  return byPath;
}

/** The rail's groups against the files the diff changes, numbered in reading order. */
export function buildDiffWalkthroughRail(
  walkthrough: Pick<DiffWalkthrough, "summary" | "groups" | "notes">,
  changedPaths: ReadonlyArray<string>,
): DiffWalkthroughRailModel {
  const notesByPath = diffWalkthroughNotesByPath(walkthrough);
  let ordinal = 0;
  const groups = groupDiffWalkthroughFiles(walkthrough, changedPaths).map(
    (group): DiffWalkthroughRailGroup => ({
      id: group.id,
      ordinal: group.id === DIFF_WALKTHROUGH_OTHER_GROUP_ID ? null : ++ordinal,
      title: group.title,
      summary: group.summary,
      files: group.files.map((path) => ({
        key: diffWalkthroughFileKey(path),
        path,
        notes: notesByPath.get(path) ?? NO_NOTES,
      })),
    }),
  );
  return { summary: walkthrough.summary ?? null, groups };
}

export function diffWalkthroughGroupProgress(
  group: DiffWalkthroughRailGroup,
  isViewed: (path: string) => boolean,
): { readonly viewed: number; readonly total: number } {
  let viewed = 0;
  for (const file of group.files) if (isViewed(file.path)) viewed += 1;
  return { viewed, total: group.files.length };
}

/**
 * Index of the last of `count` ascending positions at or above `probe`, or -1 when the first is
 * already below it. `topAt` may skip a position it cannot place by returning undefined.
 */
export function lastIndexAtOrAbove(
  count: number,
  topAt: (index: number) => number | undefined,
  probe: number,
): number {
  let low = 0;
  let high = count - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const top = topAt(middle);
    if (top === undefined || top <= probe) {
      if (top !== undefined) found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * The rail entry for what is under the reading line: the last note on the visible file that
 * starts at or above it, or the file itself when the reader has not reached its first note.
 * `noteTop` is where a note's first line sits in the same space as `probe`, or undefined when
 * the viewer cannot place it (a folded file, a line outside every hunk).
 */
export function activeDiffWalkthroughEntryKey(
  notesByPath: ReadonlyMap<string, ReadonlyArray<DiffWalkthroughRailNote>>,
  visible: {
    readonly path: string;
    readonly probe: number;
    readonly noteTop: (note: DiffWalkthroughNote) => number | undefined;
  } | null,
): string | null {
  if (visible === null) return null;
  let active = diffWalkthroughFileKey(visible.path);
  let activeTop = -Infinity;
  // Notes are in reading order, not line order, so every one is weighed rather than searched.
  for (const entry of notesByPath.get(visible.path) ?? NO_NOTES) {
    const top = visible.noteTop(entry.note);
    if (top === undefined || top > visible.probe || top < activeTop) continue;
    active = entry.key;
    activeTop = top;
  }
  return active;
}

/**
 * What the rail says when the walkthrough was written for another revision. Null when it is
 * current, and when the live revision is unknown, since there is nothing to tell it by.
 */
export function diffWalkthroughStaleNotice(
  walkthrough: Pick<DiffWalkthrough, "target">,
  liveTarget: DiffWalkthroughTarget | null,
): string | null {
  if (liveTarget === null || !isDiffWalkthroughStale(walkthrough, liveTarget)) return null;
  const stored = walkthrough.target;
  return stored.kind === "pull-request"
    ? `Out of date: written for ${stored.headSha.slice(0, 7)}`
    : "Out of date";
}
