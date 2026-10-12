import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { TurnCountRange } from "./checkpointDiff.ts";

/**
 * The diff a walkthrough describes. Only diffs with a stable revision are walkable: a pull
 * request at one head commit, a thread's checkpoint pair, or a branch's committed range from its
 * merge base to HEAD. A working tree has nothing to tell a stale walkthrough from a current one
 * by, so it is not a target.
 *
 * The pull request fields are `PullRequestRef`'s identity without its transport-only fields.
 * `headSha` is the revision the walkthrough was written against, and is deliberately left out of
 * `diffWalkthroughTargetKey`: storage holds one walkthrough per pull request, and a client tells
 * a stale one by comparing `headSha` with the live `PullRequestDetail.headSha`.
 */
export const DiffWalkthroughPullRequestIdentity = Schema.Struct({
  kind: Schema.Literal("pull-request"),
  projectId: ProjectId,
  /** Absent means the project's own host, as on `PullRequestRef`. */
  host: Schema.optional(TrimmedNonEmptyString),
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type DiffWalkthroughPullRequestIdentity = typeof DiffWalkthroughPullRequestIdentity.Type;

export const DiffWalkthroughPullRequestTarget = Schema.Struct({
  ...DiffWalkthroughPullRequestIdentity.fields,
  headSha: TrimmedNonEmptyString,
});
export type DiffWalkthroughPullRequestTarget = typeof DiffWalkthroughPullRequestTarget.Type;

/** A checkpoint pair, which is fixed once both turns have been checkpointed. */
export const DiffWalkthroughThreadDiffTarget = TurnCountRange.mapFields(
  Struct.assign({
    kind: Schema.Literal("thread-diff"),
    threadId: ThreadId,
  }),
  { unsafePreserveChecks: true },
);
export type DiffWalkthroughThreadDiffTarget = typeof DiffWalkthroughThreadDiffTarget.Type;

/**
 * A branch's committed range, `baseSha..headSha`, so a branch can be walked before it has a pull
 * request. Keyed by branch rather than thread: several threads and worktrees can share a branch,
 * and a pull request opened from it is matched by its head branch name and head SHA. Both SHAs
 * are the revision; the walkthrough is stale once either moves. A detached HEAD has no branch and
 * is not walkable.
 */
export const DiffWalkthroughBranchRangeIdentity = Schema.Struct({
  kind: Schema.Literal("branch-range"),
  projectId: ProjectId,
  branch: TrimmedNonEmptyString,
});
export type DiffWalkthroughBranchRangeIdentity = typeof DiffWalkthroughBranchRangeIdentity.Type;

export const DiffWalkthroughBranchRangeTarget = Schema.Struct({
  ...DiffWalkthroughBranchRangeIdentity.fields,
  /** The merge base the range starts from. */
  baseSha: TrimmedNonEmptyString,
  headSha: TrimmedNonEmptyString,
});
export type DiffWalkthroughBranchRangeTarget = typeof DiffWalkthroughBranchRangeTarget.Type;

export const DiffWalkthroughTarget = Schema.Union([
  DiffWalkthroughPullRequestTarget,
  DiffWalkthroughThreadDiffTarget,
  DiffWalkthroughBranchRangeTarget,
]);
export type DiffWalkthroughTarget = typeof DiffWalkthroughTarget.Type;

/**
 * A target without its revision: what storage is keyed by and what a reader follows, so a pull
 * request moving to a new head neither changes what is read nor restarts a subscription.
 */
export const DiffWalkthroughTargetIdentity = Schema.Union([
  DiffWalkthroughPullRequestIdentity,
  DiffWalkthroughThreadDiffTarget,
  DiffWalkthroughBranchRangeIdentity,
]);
export type DiffWalkthroughTargetIdentity = typeof DiffWalkthroughTargetIdentity.Type;

/**
 * The storage identity of a target, without its revision, so writing a walkthrough for a new
 * head replaces the old one.
 *
 * A pull request is keyed host-level like a thread's pull request link
 * (`threadPullRequestKeyOf`): `host/repository#number`, lowercased. The server should resolve an
 * absent host to the project's own before keying, so a reference with and without a host lands
 * on one walkthrough. Unresolved, the key falls back to the project, which never collides with a
 * host-level one. A branch range is keyed by project and branch name, which is case-sensitive.
 */
export function diffWalkthroughTargetKey(target: DiffWalkthroughTargetIdentity): string {
  switch (target.kind) {
    case "pull-request": {
      const repository = target.repository.trim().toLowerCase();
      const scope =
        target.host === undefined
          ? `project:${target.projectId}`
          : `host:${target.host.trim().toLowerCase()}`;
      return `pull-request:${scope}/${repository}#${target.number}`;
    }
    case "thread-diff":
      return `thread-diff:${target.threadId}:${target.fromTurnCount}-${target.toTurnCount}`;
    case "branch-range":
      return `branch-range:${target.projectId}:${target.branch}`;
  }
}

/**
 * The stored walkthrough was written against another revision of the same target. A pull
 * request moves with its head, a branch range with either end; a checkpoint pair never moves.
 */
export function isDiffWalkthroughStale(
  walkthrough: Pick<DiffWalkthrough, "target">,
  liveTarget: DiffWalkthroughTarget,
): boolean {
  const stored = walkthrough.target;
  if (stored.kind === "pull-request" && liveTarget.kind === "pull-request") {
    return stored.headSha !== liveTarget.headSha;
  }
  if (stored.kind === "branch-range" && liveTarget.kind === "branch-range") {
    return stored.baseSha !== liveTarget.baseSha || stored.headSha !== liveTarget.headSha;
  }
  return false;
}

const MAX_GROUPS = 100;
const MAX_NOTES = 2000;
const MAX_FILES_PER_GROUP = 1000;
const MAX_QUESTIONS_PER_GROUP = 2;

/** As on pull request file marks: untrimmed, because a space can be part of a file's name. */
const DiffWalkthroughFilePath = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096));

/** One line a rail row can show whole. */
const DiffWalkthroughSummaryLine = TrimmedNonEmptyString.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[^\r\n]*$/, { message: "summary must be a single line" }),
);

/** Why a group deserves a slower read: a call the diff alone cannot settle. */
export const DiffWalkthroughAttentionKind = Schema.Literals([
  "tradeoff",
  "contract",
  "product",
  "risk",
  "accessibility",
]);
export type DiffWalkthroughAttentionKind = typeof DiffWalkthroughAttentionKind.Type;

export const DiffWalkthroughAttention = Schema.Struct({
  kind: DiffWalkthroughAttentionKind,
  note: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)),
});
export type DiffWalkthroughAttention = typeof DiffWalkthroughAttention.Type;

export const DiffWalkthroughGroupFile = Schema.Struct({
  path: DiffWalkthroughFilePath,
  /** What this file contributes when its diff does not say, for example "same rename as X". */
  note: Schema.optionalKey(DiffWalkthroughSummaryLine),
});
export type DiffWalkthroughGroupFile = typeof DiffWalkthroughGroupFile.Type;

/**
 * Shaped like a guided review's stop, so one translates into the other by copying fields.
 * `attention` and `questions` default when an agent leaves them out, and are always encoded.
 */
export const DiffWalkthroughGroup = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  /** The intent behind these files, in a sentence or two. */
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)),
  attention: Schema.NullOr(DiffWalkthroughAttention).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  files: Schema.Array(DiffWalkthroughGroupFile).check(Schema.isMaxLength(MAX_FILES_PER_GROUP)),
  /** Questions about intent a reader might ask here, never requests to review something. */
  questions: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(500)))
    .check(Schema.isMaxLength(MAX_QUESTIONS_PER_GROUP))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
export type DiffWalkthroughGroup = typeof DiffWalkthroughGroup.Type;

/**
 * Lines of one file, in a guided review's spelling: `new` numbers lines of the new file, `old`
 * lines of the old one. A note sits on lines the change touched on its side; the server drops
 * one that covers none and narrows one that reaches past them.
 */
export const DiffWalkthroughSide = Schema.Literals(["new", "old"]);
export type DiffWalkthroughSide = typeof DiffWalkthroughSide.Type;

export const DiffWalkthroughAnchor = Schema.Struct({
  path: DiffWalkthroughFilePath,
  side: DiffWalkthroughSide,
  start: PositiveInt,
  end: PositiveInt,
});
export type DiffWalkthroughAnchor = typeof DiffWalkthroughAnchor.Type;

export const DiffWalkthroughNote = Schema.Struct({
  groupId: TrimmedNonEmptyString,
  ...DiffWalkthroughAnchor.fields,
  summary: DiffWalkthroughSummaryLine,
  /** Markdown, for what does not fit the one line. */
  body: Schema.optional(Schema.String.check(Schema.isMaxLength(8000))),
}).check(
  Schema.makeFilter((note) => note.start <= note.end || "start must be less than or equal to end", {
    identifier: "DiffWalkthroughNoteLineRange",
  }),
);
export type DiffWalkthroughNote = typeof DiffWalkthroughNote.Type;

export const DiffWalkthroughAuthor = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  provider: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
});
export type DiffWalkthroughAuthor = typeof DiffWalkthroughAuthor.Type;

function walkthroughProblem(input: {
  readonly groups: ReadonlyArray<DiffWalkthroughGroup>;
  readonly notes: ReadonlyArray<DiffWalkthroughNote>;
}): string | undefined {
  const filesByGroup = new Map<string, ReadonlySet<string>>();
  const groupOfFile = new Map<string, string>();
  for (const group of input.groups) {
    if (filesByGroup.has(group.id)) return `group id "${group.id}" is used more than once`;
    const paths = group.files.map((file) => file.path);
    filesByGroup.set(group.id, new Set(paths));
    for (const path of paths) {
      const owner = groupOfFile.get(path);
      if (owner !== undefined && owner !== group.id) {
        return `file "${path}" is in both group "${owner}" and group "${group.id}"`;
      }
      groupOfFile.set(path, group.id);
    }
  }
  for (const note of input.notes) {
    const files = filesByGroup.get(note.groupId);
    if (files === undefined) return `note on "${note.path}" names unknown group "${note.groupId}"`;
    if (!files.has(note.path)) {
      return `note on "${note.path}" is not a file of group "${note.groupId}"`;
    }
  }
  return undefined;
}

/**
 * An agent's guide to a diff. `groups` is the suggested reading order, and `notes` are in
 * reading order within each file. A file belongs to at most one group, and every note sits on a
 * file of the group it names.
 */
export const DiffWalkthrough = Schema.Struct({
  target: DiffWalkthroughTarget,
  /** The change as a whole, in a paragraph. */
  summary: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2000))),
  groups: Schema.Array(DiffWalkthroughGroup).check(Schema.isMaxLength(MAX_GROUPS)),
  notes: Schema.Array(DiffWalkthroughNote).check(Schema.isMaxLength(MAX_NOTES)),
  generatedAt: IsoDateTime,
  author: DiffWalkthroughAuthor,
}).check(
  Schema.makeFilter((walkthrough) => walkthroughProblem(walkthrough) ?? true, {
    identifier: "DiffWalkthroughConsistency",
  }),
);
export type DiffWalkthrough = typeof DiffWalkthrough.Type;

export const DIFF_WALKTHROUGH_OTHER_GROUP_ID = "__other__";

/**
 * The groups to show against the files the diff actually changes. Files the walkthrough names
 * but the diff no longer touches are dropped, and changed files it never placed land in a
 * trailing "Other" group, so a walkthrough neither hides a file nor shows a ghost. Groups left
 * with no files are dropped, as is an empty "Other".
 */
export function groupDiffWalkthroughFiles(
  walkthrough: Pick<DiffWalkthrough, "groups">,
  changedPaths: ReadonlyArray<string>,
): ReadonlyArray<DiffWalkthroughGroup> {
  const changed = new Set(changedPaths);
  const placed = new Set<string>();
  const groups: DiffWalkthroughGroup[] = [];
  for (const group of walkthrough.groups) {
    const files: DiffWalkthroughGroupFile[] = [];
    for (const file of group.files) {
      if (!changed.has(file.path) || placed.has(file.path)) continue;
      placed.add(file.path);
      files.push(file);
    }
    if (files.length > 0) groups.push({ ...group, files });
  }
  const unplaced = [...changed].filter((path) => !placed.has(path));
  if (unplaced.length > 0) {
    groups.push({
      id: DIFF_WALKTHROUGH_OTHER_GROUP_ID,
      title: "Other",
      summary: "Changed files the walkthrough does not cover.",
      attention: null,
      files: unplaced.map((path) => ({ path })),
      questions: [],
    });
  }
  return groups;
}

export const DiffWalkthroughGetInput = Schema.Struct({
  /** The result is whatever is stored for this target, whichever revision it was written for. */
  target: DiffWalkthroughTargetIdentity,
});
export type DiffWalkthroughGetInput = typeof DiffWalkthroughGetInput.Type;

export const DiffWalkthroughGetResult = Schema.Struct({
  walkthrough: Schema.NullOr(DiffWalkthrough),
});
export type DiffWalkthroughGetResult = typeof DiffWalkthroughGetResult.Type;

export const DiffWalkthroughPutInput = Schema.Struct({
  walkthrough: DiffWalkthrough,
});
export type DiffWalkthroughPutInput = typeof DiffWalkthroughPutInput.Type;

export const DiffWalkthroughPutResult = Schema.Struct({
  walkthrough: DiffWalkthrough,
});
export type DiffWalkthroughPutResult = typeof DiffWalkthroughPutResult.Type;

export class DiffWalkthroughError extends Schema.TaggedError<DiffWalkthroughError>()(
  "DiffWalkthroughError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
