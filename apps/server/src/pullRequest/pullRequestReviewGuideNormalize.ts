import type { PullRequestReviewGuideExcerpt, PullRequestReviewGuideStop } from "@t3tools/contracts";
import type { ReviewGuideGenerationResult } from "@t3tools/provider-core/server/textGeneration";

import { clampToChange, type DiffChange } from "../review/diffChange.ts";

const MAX_EXCERPT_LINES = 25;

function mergeExcerpts(
  excerpts: ReadonlyArray<PullRequestReviewGuideExcerpt>,
): Array<PullRequestReviewGuideExcerpt> {
  let merged: Array<PullRequestReviewGuideExcerpt> = [];
  for (const excerpt of excerpts) {
    const touches = (other: PullRequestReviewGuideExcerpt) =>
      other.path === excerpt.path &&
      other.side === excerpt.side &&
      other.start <= excerpt.end + 1 &&
      excerpt.start <= other.end + 1;
    // An excerpt can bridge several earlier ones; fold them all into the first.
    const group = merged.filter(touches);
    const first = group[0];
    if (first === undefined) {
      merged.push(excerpt);
      continue;
    }
    const combined = {
      ...first,
      start: Math.min(excerpt.start, ...group.map((other) => other.start)),
      end: Math.max(excerpt.end, ...group.map((other) => other.end)),
      caption: group.find((other) => other.caption)?.caption ?? excerpt.caption,
    };
    merged = merged.flatMap((other) =>
      other === first ? [combined] : touches(other) ? [] : [other],
    );
  }
  return merged.map((excerpt) => ({
    ...excerpt,
    end: Math.min(excerpt.end, excerpt.start + MAX_EXCERPT_LINES - 1),
  }));
}

const nonEmpty = (value: string) => value.trim() !== "";

export function normalizeReviewGuide(
  guide: ReviewGuideGenerationResult,
  change: DiffChange,
): ReviewGuideGenerationResult {
  const changed = new Set(change.files);
  const inChange = (path: string) => changed.has(path);

  const shaped: Array<PullRequestReviewGuideStop> = guide.stops
    .filter((stop) => nonEmpty(stop.title))
    .map((stop) => {
      const excerpts = mergeExcerpts(
        stop.excerpts.flatMap((excerpt) => {
          const clamped = inChange(excerpt.path) ? clampToChange(excerpt, change) : null;
          return clamped === null ? [] : [clamped];
        }),
      );
      return {
        ...stop,
        attention: stop.attention !== null && nonEmpty(stop.attention.note) ? stop.attention : null,
        excerpts,
        files: stop.files
          .filter((file) => inChange(file.path))
          .map(({ path, note }) => (note?.trim() ? { path, note } : { path })),
        notes: stop.notes.filter(
          (note) =>
            nonEmpty(note.title) &&
            excerpts.some(
              (excerpt) =>
                excerpt.path === note.path &&
                excerpt.start <= note.line &&
                note.line <= excerpt.end,
            ),
        ),
        questions: stop.questions.filter(nonEmpty),
      };
    });

  const placed = new Set(shaped.flatMap((stop) => stop.excerpts.map((excerpt) => excerpt.path)));
  const stops = shaped.map((stop) => {
    const files = stop.files.filter((file) => !placed.has(file.path));
    for (const file of files) placed.add(file.path);
    return { ...stop, files };
  });
  const unplaced = change.files.filter((path) => !placed.has(path));
  if (unplaced.length > 0) {
    stops.push({
      title: "Other files",
      summary: "Changed files the tour does not otherwise cover.",
      attention: null,
      excerpts: [],
      files: unplaced.map((path) => ({ path })),
      notes: [],
      questions: [],
    });
  }

  return { ...guide, stops };
}
