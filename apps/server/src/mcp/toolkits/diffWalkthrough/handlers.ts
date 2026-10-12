import {
  type DiffWalkthroughAuthor,
  type DiffWalkthroughBranchRangeTarget,
  type DiffWalkthroughError,
  type DiffWalkthroughPullRequestIdentity,
  type DiffWalkthroughTarget,
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  type ReviewDiffFileStat,
  type ThreadId,
  isDiffWalkthroughStale,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import type { CheckpointServiceError } from "../../../checkpointing/Errors.ts";
import * as DiffWalkthroughService from "../../../diffWalkthrough/DiffWalkthroughService.ts";
import * as DiffWalkthroughWriter from "../../../diffWalkthrough/DiffWalkthroughWriter.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { diffSectionPath, diffSectionPaths } from "../../../review/diffChange.ts";
import * as ReviewService from "../../../review/ReviewService.ts";
import { OUTPUT_TRUNCATED_MARKER } from "../../../vcs/GitVcsDriverCore.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, resolveThreadId, unavailable } from "../../threadAccess.ts";
import { resolveTarget as resolvePullRequestTarget } from "../pullRequests/handlers.ts";
import {
  BranchRangeUnavailableError,
  DiffWalkthroughRejectedError,
  DiffWalkthroughToolkit,
  ThreadDiffReadFailedError,
} from "./tools.ts";

/** Enough for a large change, small enough not to swamp an agent's context. */
export const THREAD_DIFF_CHARACTER_LIMIT = 200_000;

const FILE_HEADER = "diff --git ";

/**
 * A unified diff cut to `limit` characters at a file boundary, with the files it left out. A
 * file is never cut partway, so what an agent reads is always a whole file's change.
 */
export function boundThreadDiff(
  diff: string,
  limit: number,
): { readonly diff: string; readonly omittedFiles: ReadonlyArray<string> } {
  if (diff.length <= limit) return { diff, omittedFiles: [] };
  const sections = diff.split(/^(?=diff --git )/m);
  let kept = "";
  let index = 0;
  for (; index < sections.length; index += 1) {
    const section = sections[index]!;
    if (kept.length + section.length > limit) break;
    kept += section;
  }
  return {
    diff: kept,
    omittedFiles: sections
      .slice(index)
      .filter((section) => section.startsWith(FILE_HEADER))
      .map(diffSectionPath),
  };
}

/**
 * The review diff's patch, which git cut at a byte limit possibly partway through a file, as
 * whole files only, naming every changed file it leaves out from the complete statistics.
 */
export function boundReviewDiff(source: {
  readonly diff: string;
  readonly truncated: boolean;
  readonly files?: ReadonlyArray<ReviewDiffFileStat>;
}): {
  readonly diff: string;
  readonly truncated: boolean;
  readonly omittedFiles: ReadonlyArray<string>;
} {
  let diff = source.diff;
  if (diff.endsWith(OUTPUT_TRUNCATED_MARKER)) {
    diff = diff.slice(0, -OUTPUT_TRUNCATED_MARKER.length);
    const lastFile = diff.lastIndexOf(`\n${FILE_HEADER}`);
    diff = lastFile === -1 ? "" : diff.slice(0, lastFile + 1);
  }
  const bounded = boundThreadDiff(diff, THREAD_DIFF_CHARACTER_LIMIT);
  const kept = new Set(diffSectionPaths(bounded.diff));
  const omittedFiles =
    source.files === undefined
      ? bounded.omittedFiles
      : source.files.map((file) => file.path).filter((path) => !kept.has(path));
  return {
    diff: bounded.diff,
    truncated: source.truncated || omittedFiles.length > 0,
    omittedFiles,
  };
}

/** The service's own message, with the schema's account of what is wrong when there is one. */
const rejected = (error: DiffWalkthroughError) =>
  new DiffWalkthroughRejectedError({
    message: Schema.isSchemaError(error.cause)
      ? `${error.message} ${error.cause.message}`
      : error.message,
  });

/** A missing checkpoint is the agent's to fix; storage and git failures stay private. */
const diffReadFailed = (error: CheckpointServiceError) =>
  new ThreadDiffReadFailedError({
    message:
      error._tag === "CheckpointTurnRangeUnavailableError" ||
      error._tag === "CheckpointRefUnavailableError"
        ? error.message
        : "Could not read the thread diff.",
  });

function describeTarget(target: DiffWalkthroughTarget): string {
  switch (target.kind) {
    case "pull-request":
      return `pull request ${[target.host, target.repository].filter(Boolean).join("/")}#${target.number} at ${target.headSha.slice(0, 12)}`;
    case "thread-diff":
      return `turns ${target.fromTurnCount} to ${target.toTurnCount} of thread ${target.threadId}`;
    case "branch-range":
      return `branch ${target.branch} from ${target.baseSha.slice(0, 12)} to ${target.headSha.slice(0, 12)}`;
  }
}

/** A note's lines as an agent can find them again: `path:start-end`, marked when on the old side. */
const anchorLabel = (anchor: { path: string; side: string; start: number; end: number }) =>
  `${anchor.path}:${anchor.start}-${anchor.end}${anchor.side === "old" ? " (old)" : ""}`;

const narrowedLabel = (note: DiffWalkthroughWriter.DiffWalkthroughHold["narrowed"][number]) =>
  `${anchorLabel({ ...note, ...note.from })} to ${note.to.start}-${note.to.end}`;

const notesCount = (count: number) => (count === 1 ? "1 note was" : `${count} notes were`);

/** What holding the notes to the change did, in sentences that tell the agent what to correct. */
function describeHold(held: DiffWalkthroughWriter.DiffWalkthroughHold): string {
  if (!held.clamped) {
    return `Notes were stored as written, without checking them against the change: ${held.reason ?? "it could not be read."}`;
  }
  const sentences: Array<string> = [];
  if (held.dropped.length > 0) {
    sentences.push(
      `${notesCount(held.dropped.length)} outside the lines this change touched and dropped: ${held.dropped.map(anchorLabel).join(", ")}.`,
    );
  }
  if (held.narrowed.length > 0) {
    sentences.push(
      `${notesCount(held.narrowed.length)} narrowed to the lines the change touched: ${held.narrowed.map(narrowedLabel).join(", ")}.`,
    );
  }
  if (sentences.length > 0) {
    sentences.push(
      "Anchor notes on added or removed lines, and write the walkthrough again if a dropped note mattered.",
    );
  }
  return sentences.join(" ");
}

const make = Effect.gen(function* () {
  const walkthroughs = yield* DiffWalkthroughService.DiffWalkthroughService;
  const writer = yield* DiffWalkthroughWriter.DiffWalkthroughWriter;
  const diffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const projects = yield* ProjectService.ProjectService;
  const reviews = yield* ReviewService.ReviewService;

  /** The thread a call targets, the calling one when omitted, with the caller. */
  const targetThread = Effect.fn("DiffWalkthroughToolkit.targetThread")(function* (
    threadId: ThreadId | undefined,
  ) {
    const context = yield* readCaller();
    const id = yield* resolveThreadId(context, threadId);
    const thread = yield* context.threads.getThreadShell(id).pipe(Effect.mapError(unavailable));
    if (thread === null || thread.deletedAt !== null) {
      return yield* new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: "The thread was not found.",
      });
    }
    return { caller: context.caller, thread };
  });

  const projectOf = (thread: OrchestrationV2ThreadShell) =>
    projects
      .getShell(thread.projectId)
      .pipe(Effect.map(Option.getOrUndefined), Effect.mapError(unavailable));

  const pullRequestIdentity = Effect.fn("DiffWalkthroughToolkit.pullRequestIdentity")(function* (
    thread: OrchestrationV2ThreadShell,
    input: Parameters<typeof resolvePullRequestTarget>[0],
  ) {
    const pullRequest = yield* resolvePullRequestTarget(input, yield* projectOf(thread));
    return {
      kind: "pull-request",
      projectId: thread.projectId,
      host: pullRequest.host,
      repository: pullRequest.repository,
      number: pullRequest.number,
    } satisfies DiffWalkthroughPullRequestIdentity;
  });

  /**
   * The thread checkout's branch range as the Changes view reads it: the merge base with the
   * base branch to the working tree, with the commits that bound its committed part.
   */
  const readBranchRange = Effect.fn("DiffWalkthroughToolkit.readBranchRange")(function* (
    thread: OrchestrationV2ThreadShell,
    ignoreWhitespace: boolean,
  ) {
    const project = yield* projectOf(thread);
    if (project === undefined) {
      return yield* new BranchRangeUnavailableError({ message: "The project was not found." });
    }
    const preview = yield* reviews
      .getDiffPreview({ cwd: thread.worktreePath ?? project.workspaceRoot, ignoreWhitespace })
      .pipe(
        Effect.mapError(
          () => new BranchRangeUnavailableError({ message: "Could not read the branch diff." }),
        ),
      );
    const source = preview.sources.find((candidate) => candidate.kind === "branch-range");
    if (source === undefined) {
      return yield* new BranchRangeUnavailableError({
        message: "The thread's checkout is not a git repository.",
      });
    }
    // headRef is the checked-out branch, or HEAD when detached; no branch can be named HEAD.
    if (source.headRef === null || source.headRef === "HEAD") {
      return yield* new BranchRangeUnavailableError({
        message: "The thread's checkout is not on a branch (detached HEAD).",
      });
    }
    if (source.baseSha === undefined || source.headSha === undefined) {
      return yield* new BranchRangeUnavailableError({ message: "The branch has no commits yet." });
    }
    const uncommitted = preview.sources.find((candidate) => candidate.kind === "working-tree");
    return {
      target: {
        kind: "branch-range",
        projectId: thread.projectId,
        branch: source.headRef,
        baseSha: source.baseSha,
        headSha: source.headSha,
      } satisfies DiffWalkthroughBranchRangeTarget,
      source,
      includesUncommittedChanges:
        uncommitted !== undefined &&
        (uncommitted.diff.length > 0 || (uncommitted.files?.length ?? 0) > 0),
    };
  });

  return {
    write_diff_walkthrough: McpToolAccess.writesThreads(
      (input) => [input.target.threadId],
      (input) =>
        Effect.gen(function* () {
          const { caller, thread } = yield* targetThread(input.target.threadId);
          let target: DiffWalkthroughTarget;
          switch (input.target.kind) {
            case "pull-request":
              target = {
                ...(yield* pullRequestIdentity(thread, input.target)),
                headSha: input.target.headSha,
              };
              break;
            case "thread-diff":
              target = {
                kind: "thread-diff",
                threadId: thread.id,
                fromTurnCount: input.target.fromTurnCount,
                toTurnCount: input.target.toTurnCount,
              };
              break;
            case "branch-range":
              target = (yield* readBranchRange(thread, true)).target;
              break;
          }
          const author: DiffWalkthroughAuthor =
            caller === undefined
              ? {}
              : {
                  threadId: caller.id,
                  provider: caller.providerInstanceId,
                  model: caller.modelSelection.model,
                };
          const { walkthrough: stored, held } = yield* writer
            .write({
              target,
              ...(input.summary === undefined ? {} : { summary: input.summary }),
              groups: input.groups.map((group) => ({
                ...group,
                attention: group.attention ?? null,
                questions: group.questions ?? [],
              })),
              notes: input.notes,
              generatedAt: DateTime.formatIso(yield* DateTime.now),
              author,
            })
            .pipe(Effect.mapError(rejected));
          const described = describeTarget(stored.target);
          const hold = describeHold(held);
          return {
            target: stored.target,
            groupCount: stored.groups.length,
            noteCount: stored.notes.length,
            heldToChange: held.clamped,
            droppedNotes: held.dropped.map(anchorLabel),
            narrowedNotes: held.narrowed.map(narrowedLabel),
            confirmation: `Stored the walkthrough of ${described} with ${stored.notes.length} ${stored.notes.length === 1 ? "note" : "notes"}.${hold === "" ? "" : ` ${hold}`}`,
          };
        }),
    ),
    read_thread_diff: McpToolAccess.reads(({ target, ignoreWhitespace }) =>
      Effect.gen(function* () {
        const { thread } = yield* targetThread(target.threadId);
        if (target.kind === "branch-range") {
          const range = yield* readBranchRange(thread, ignoreWhitespace ?? true);
          return {
            kind: "branch-range" as const,
            threadId: thread.id,
            branch: range.target.branch,
            baseRef: range.source.baseRef,
            baseSha: range.target.baseSha,
            headSha: range.target.headSha,
            includesUncommittedChanges: range.includesUncommittedChanges,
            ...boundReviewDiff(range.source),
          };
        }
        const result = yield* diffs
          .getTurnDiff({
            threadId: thread.id,
            fromTurnCount: target.fromTurnCount,
            toTurnCount: target.toTurnCount,
            ...(ignoreWhitespace === undefined ? {} : { ignoreWhitespace }),
          })
          .pipe(Effect.mapError(diffReadFailed));
        const bounded = boundThreadDiff(result.diff, THREAD_DIFF_CHARACTER_LIMIT);
        return {
          kind: "thread-diff" as const,
          threadId: thread.id,
          fromTurnCount: result.fromTurnCount,
          toTurnCount: result.toTurnCount,
          diff: bounded.diff,
          truncated: bounded.omittedFiles.length > 0,
          omittedFiles: bounded.omittedFiles,
        };
      }),
    ),
    read_diff_walkthrough: McpToolAccess.reads(({ target }) =>
      Effect.gen(function* () {
        const { thread } = yield* targetThread(target.threadId);
        switch (target.kind) {
          case "pull-request": {
            const walkthrough = yield* walkthroughs
              .get(yield* pullRequestIdentity(thread, target))
              .pipe(Effect.mapError(rejected));
            // Telling needs the host's live head, which is not cheap to read here.
            return { walkthrough, stale: null };
          }
          case "thread-diff": {
            const walkthrough = yield* walkthroughs
              .get({
                kind: "thread-diff",
                threadId: thread.id,
                fromTurnCount: target.fromTurnCount,
                toTurnCount: target.toTurnCount,
              })
              .pipe(Effect.mapError(rejected));
            return { walkthrough, stale: walkthrough === null ? null : false };
          }
          case "branch-range": {
            const live = (yield* readBranchRange(thread, true)).target;
            const walkthrough = yield* walkthroughs.get(live).pipe(Effect.mapError(rejected));
            return {
              walkthrough,
              stale: walkthrough === null ? null : isDiffWalkthroughStale(walkthrough, live),
            };
          }
        }
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof DiffWalkthroughToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(DiffWalkthroughToolkit, make);
