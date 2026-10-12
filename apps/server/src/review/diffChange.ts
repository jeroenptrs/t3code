import { unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";

interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** The lines a change touched in one file, on each side of the diff. */
interface FileHunks {
  readonly new: Array<LineRange>;
  readonly old: Array<LineRange>;
}

/** What a guide or a walkthrough is held to: the changed paths, and the lines each touched. */
export interface DiffChange {
  /** Every changed path, in diff order, named as `git diff --name-only` names it. */
  readonly files: ReadonlyArray<string>;
  readonly hunks: ReadonlyMap<string, FileHunks>;
}

/** Lines of one file, as guide excerpts and walkthrough notes anchor them. */
export interface DiffLineAnchor {
  readonly path: string;
  readonly side: "new" | "old";
  readonly start: number;
  readonly end: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const hunkRange = (start: string, count: string | undefined): LineRange | null => {
  const lines = count === undefined ? 1 : Number(count);
  return lines === 0 ? null : { start: Number(start), end: Number(start) + lines - 1 };
};

/**
 * Reads `git diff --name-only -z` and `git diff --unified=0` of the same range. Hunks are keyed
 * by the new path, or the old one for a deleted file, so both sides of a renamed file sit under
 * the name the model sees in `--stat`.
 */
export function parseDiffChange(nameOnly: string, patch: string): DiffChange {
  const hunks = new Map<string, FileHunks>();
  let oldPath: string | null = null;
  let current: FileHunks | null = null;
  // Inside a file's hunks a `--- ` or `+++ ` line is a removed or added source line, not a header.
  let inHunks = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      oldPath = null;
      current = null;
      inHunks = false;
    } else if (!inHunks && line.startsWith("--- ")) {
      oldPath = line.startsWith("--- a/") ? line.slice(6) : null;
    } else if (!inHunks && line.startsWith("+++ ")) {
      const path = line.startsWith("+++ b/") ? line.slice(6) : oldPath;
      if (path === null) continue;
      current = hunks.get(path) ?? { new: [], old: [] };
      hunks.set(path, current);
    } else if (current !== null) {
      const header = HUNK_HEADER.exec(line);
      if (header === null) continue;
      inHunks = true;
      const removed = hunkRange(header[1]!, header[2]);
      const added = hunkRange(header[3]!, header[4]);
      if (removed !== null) current.old.push(removed);
      if (added !== null) current.new.push(added);
    }
  }
  return { files: nameOnly.split("\0").filter((path) => path !== ""), hunks };
}

/**
 * Narrows an anchor to the changed lines it covers: from the first changed line it overlaps to
 * the last. Null when it covers none, which means it points somewhere the change is not.
 */
export function clampToChange<Anchor extends DiffLineAnchor>(
  anchor: Anchor,
  change: DiffChange,
): Anchor | null {
  const start = Math.min(anchor.start, anchor.end);
  const end = Math.max(anchor.start, anchor.end);
  const overlapping = (change.hunks.get(anchor.path)?.[anchor.side] ?? []).filter(
    (hunk) => hunk.start <= end && start <= hunk.end,
  );
  const first = overlapping[0];
  const last = overlapping.at(-1);
  if (first === undefined || last === undefined) return null;
  return { ...anchor, start: Math.max(start, first.start), end: Math.min(end, last.end) };
}

const FILE_HEADER = "diff --git ";

/** The file a unified diff section changes, preferring the new name. */
export function diffSectionPath(section: string): string {
  const lines = section.split("\n");
  const header = (prefix: string) => {
    const line = lines.find((candidate) => candidate.startsWith(prefix));
    if (line === undefined) return undefined;
    // A name that holds a space ends at a tab, which git appends only then.
    const token = line.slice(prefix.length).split("\t")[0]!;
    return token === "/dev/null" ? undefined : unquoteGitPatchPath(token).replace(/^[ab]\//, "");
  };
  const fromHeaders = header("+++ ") ?? header("--- ");
  if (fromHeaders !== undefined) return fromHeaders;
  // Binary and rename-only sections have no ---/+++ lines.
  const first = lines[0]!.slice(FILE_HEADER.length);
  const newSide = first.lastIndexOf(" b/");
  return newSide === -1 ? first : first.slice(newSide + 3);
}

/** Every file a unified diff changes, in order, as `diffSectionPath` names it. */
export const diffSectionPaths = (diff: string) =>
  diff
    .split(/^(?=diff --git )/m)
    .filter((section) => section.startsWith(FILE_HEADER))
    .map(diffSectionPath);
