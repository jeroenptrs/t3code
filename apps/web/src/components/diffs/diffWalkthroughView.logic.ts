import {
  type KeybindingCommand,
  DIFF_WALKTHROUGH_OTHER_GROUP_ID,
  groupDiffWalkthroughFiles,
  isDiffWalkthroughStale,
  type DiffWalkthrough,
  type DiffWalkthroughAttention,
  type DiffWalkthroughAttentionKind,
  type DiffWalkthroughNote,
  type DiffWalkthroughRun,
  type DiffWalkthroughSide,
  type DiffWalkthroughTarget,
} from "@t3tools/contracts";

import type { DiffWalkthroughViewHandle } from "./DiffWalkthroughView";

export interface DiffWalkthroughSectionNote {
  /** The note's index in the walkthrough, stable for as long as the walkthrough is. */
  readonly key: string;
  readonly note: DiffWalkthroughNote;
}

/** One step of the walkthrough: a group's whole files, with the notes written on them. */
export interface DiffWalkthroughSection {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** The trailing group of changed files the walkthrough did not place. */
  readonly isOther: boolean;
  readonly attention: DiffWalkthroughAttention | null;
  readonly files: ReadonlyArray<string>;
  /** The one-line notes the walkthrough gave some of its files, by path. */
  readonly fileNotes: ReadonlyMap<string, string>;
  readonly notes: ReadonlyArray<DiffWalkthroughSectionNote>;
  readonly questions: ReadonlyArray<string>;
}

export interface DiffWalkthroughSections {
  readonly summary: string | null;
  readonly sections: ReadonlyArray<DiffWalkthroughSection>;
}

/**
 * The walkthrough's groups against the files the diff changes, one section each, in reading
 * order. A note stays only while its file is still in its section, in the order it was written.
 */
export function buildDiffWalkthroughSections(
  walkthrough: Pick<DiffWalkthrough, "summary" | "groups" | "notes">,
  changedPaths: ReadonlyArray<string>,
): DiffWalkthroughSections {
  const notesByGroup = new Map<string, DiffWalkthroughSectionNote[]>();
  walkthrough.notes.forEach((note, index) => {
    const entry = { key: `note:${index}`, note };
    const existing = notesByGroup.get(note.groupId);
    if (existing === undefined) notesByGroup.set(note.groupId, [entry]);
    else existing.push(entry);
  });
  const sections = groupDiffWalkthroughFiles(walkthrough, changedPaths).map(
    (group): DiffWalkthroughSection => {
      const files = group.files.map((file) => file.path);
      const present = new Set(files);
      return {
        id: group.id,
        title: group.title,
        summary: group.summary,
        isOther: group.id === DIFF_WALKTHROUGH_OTHER_GROUP_ID,
        attention: group.attention,
        files,
        fileNotes: new Map(
          group.files.flatMap((file) =>
            file.note === undefined ? [] : [[file.path, file.note] as const],
          ),
        ),
        notes: (notesByGroup.get(group.id) ?? []).filter((entry) => present.has(entry.note.path)),
        questions: group.questions,
      };
    },
  );
  return { summary: walkthrough.summary ?? null, sections };
}

/** "01 / 04": zero-padded to the width of the count, so the label holds its width while stepping. */
export function formatDiffWalkthroughOrdinal(index: number, count: number): string {
  const width = Math.max(2, String(count).length);
  return `${String(index + 1).padStart(width, "0")} / ${String(count).padStart(width, "0")}`;
}

/** "path:L12-L20", with the old file's lines said as such. */
export function formatDiffWalkthroughNoteRange(note: DiffWalkthroughNote): string {
  const lines = note.start === note.end ? `L${note.start}` : `L${note.start}-L${note.end}`;
  return `${note.path}:${lines}${note.side === "old" ? " (old)" : ""}`;
}

/** A note's side as `@pierre/diffs` names it, for revealing its lines. */
export function diffWalkthroughSideToDiffSide(
  side: DiffWalkthroughSide,
): "additions" | "deletions" {
  return side === "new" ? "additions" : "deletions";
}

/** Upstream's guided review labels, so an attention reads the same in either view. */
export const DIFF_WALKTHROUGH_ATTENTION_LABELS = {
  tradeoff: "A tradeoff to weigh",
  contract: "A contract to check",
  product: "A product call",
  risk: "A risk to judge",
  accessibility: "An accessibility call",
} as const satisfies Record<DiffWalkthroughAttentionKind, string>;

/** The section's files still to mark viewed, which is what "Mark reviewed" sends. */
export function unviewedSectionFiles(
  section: Pick<DiffWalkthroughSection, "files">,
  isViewed: (path: string) => boolean,
): ReadonlyArray<string> {
  return section.files.filter((path) => !isViewed(path));
}

export function isDiffWalkthroughSectionReviewed(
  section: Pick<DiffWalkthroughSection, "files">,
  isViewed: (path: string) => boolean,
): boolean {
  return section.files.every(isViewed);
}

export function clampDiffWalkthroughSectionIndex(index: number, count: number): number {
  if (count === 0) return 0;
  return Math.min(Math.max(index, 0), count - 1);
}

/**
 * Where "Mark reviewed and continue" lands: the next section, or the last one again, which is
 * where the reader is told they are done.
 */
export function sectionIndexAfterReview(index: number, count: number): number {
  return clampDiffWalkthroughSectionIndex(index + 1, count);
}

/** The first section with a file left to view, or null when every one is reviewed. */
export function firstUnreviewedSectionIndex(
  sections: ReadonlyArray<Pick<DiffWalkthroughSection, "files">>,
  isViewed: (path: string) => boolean,
): number | null {
  const index = sections.findIndex(
    (section) => !isDiffWalkthroughSectionReviewed(section, isViewed),
  );
  return index === -1 ? null : index;
}

/**
 * What the stale banner says when the walkthrough was written for another revision. Null when it
 * is current, and when the live revision is unknown, since there is nothing to tell it by.
 */
export function diffWalkthroughStaleNotice(
  walkthrough: Pick<DiffWalkthrough, "target">,
  liveTarget: DiffWalkthroughTarget | null,
): string | null {
  if (liveTarget === null || !isDiffWalkthroughStale(walkthrough, liveTarget)) return null;
  const stored = walkthrough.target;
  return stored.kind === "pull-request" || stored.kind === "branch-range"
    ? `Written for an older commit (${stored.headSha.slice(0, 7)})`
    : "Written for an older version of this diff";
}

/**
 * The walkthrough a pull request shows. Its own wins, current or stale. Without one, a
 * walkthrough of its head branch written at the head the pull request is on now describes the
 * same commits, so it is shown as current; one at any other head is not this pull request's.
 */
export function pickPullRequestWalkthrough(
  pullRequest: DiffWalkthrough | null,
  branchRange: DiffWalkthrough | null,
  liveHeadSha: string | null,
): DiffWalkthrough | null {
  if (pullRequest !== null) return pullRequest;
  if (branchRange === null || liveHeadSha === null) return null;
  if (branchRange.target.kind !== "branch-range") return null;
  return branchRange.target.headSha === liveHeadSha ? branchRange : null;
}

/**
 * Where the background run stands for the reader. `backgroundDisabledReason` says why "Generate
 * in background" cannot start now, whatever the run is doing.
 */
export type DiffWalkthroughGenerateState = (
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | { readonly kind: "failed"; readonly detail: string }
) & { readonly backgroundDisabledReason: string | null };

/**
 * The generate actions' state from the subscription's `run` and `unavailable` and the live
 * revision. A run for an older revision still counts as running, since the server replaces it
 * on its next claim; a failure for an older revision is dropped, as it says nothing about the
 * revision on screen and a retry would read the new one anyway. `starting` is a request still in
 * flight and `requestError` one the server refused, which says more than any earlier failure.
 */
export function diffWalkthroughGenerateState(input: {
  readonly run: DiffWalkthroughRun | null;
  readonly unavailable: string | null;
  readonly liveTarget: DiffWalkthroughTarget | null;
  readonly starting: boolean;
  readonly requestError: string | null;
}): DiffWalkthroughGenerateState {
  const { run, unavailable, liveTarget } = input;
  const backgroundDisabledReason =
    unavailable ?? (liveTarget === null ? "The change's current revision is not known yet." : null);
  if (input.starting || run?._tag === "Running")
    return { kind: "running", backgroundDisabledReason };
  if (input.requestError !== null) {
    return { kind: "failed", detail: input.requestError, backgroundDisabledReason };
  }
  if (
    run?._tag === "Failed" &&
    liveTarget !== null &&
    !isDiffWalkthroughStale({ target: run.target }, liveTarget)
  ) {
    return { kind: "failed", detail: run.detail, backgroundDisabledReason };
  }
  return { kind: "idle", backgroundDisabledReason };
}

const WALKTHROUGH_STEPS: Partial<
  Record<KeybindingCommand, (handle: DiffWalkthroughViewHandle) => void>
> = {
  "walkthrough.previousSection": (handle) => handle.previous(),
  "walkthrough.nextSection": (handle) => handle.next(),
  "walkthrough.markReviewed": (handle) => handle.markReviewedAndContinue(),
};

/** What a keybinding does to the walkthrough on screen; null for commands that are not its own. */
export function walkthroughStepForCommand(
  command: KeybindingCommand | null,
): ((handle: DiffWalkthroughViewHandle) => void) | null {
  return command === null ? null : (WALKTHROUGH_STEPS[command] ?? null);
}
