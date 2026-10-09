import {
  type DiffWalkthroughAuthor,
  type DiffWalkthroughError,
  type DiffWalkthroughTarget,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import { unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import type { CheckpointServiceError } from "../../../checkpointing/Errors.ts";
import * as DiffWalkthroughService from "../../../diffWalkthrough/DiffWalkthroughService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, resolveThreadId, unavailable } from "../../threadAccess.ts";
import { resolveTarget as resolvePullRequestTarget } from "../pullRequests/handlers.ts";
import {
  DiffWalkthroughRejectedError,
  DiffWalkthroughToolkit,
  ThreadDiffReadFailedError,
} from "./tools.ts";

/** Enough for a large change, small enough not to swamp an agent's context. */
export const THREAD_DIFF_CHARACTER_LIMIT = 200_000;

const FILE_HEADER = "diff --git ";

/** The file a unified diff section changes, preferring the new name. */
function diffSectionPath(section: string): string {
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

const make = Effect.gen(function* () {
  const walkthroughs = yield* DiffWalkthroughService.DiffWalkthroughService;
  const diffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const projects = yield* ProjectService.ProjectService;

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

  return {
    write_diff_walkthrough: McpToolAccess.writesThreads(
      (input) => [input.target.threadId],
      (input) =>
        Effect.gen(function* () {
          const { caller, thread } = yield* targetThread(input.target.threadId);
          let target: DiffWalkthroughTarget;
          if (input.target.kind === "pull-request") {
            const project = yield* projects
              .getShell(thread.projectId)
              .pipe(Effect.map(Option.getOrUndefined), Effect.mapError(unavailable));
            const pullRequest = yield* resolvePullRequestTarget(input.target, project);
            target = {
              kind: "pull-request",
              projectId: thread.projectId,
              host: pullRequest.host,
              repository: pullRequest.repository,
              number: pullRequest.number,
              headSha: input.target.headSha,
            };
          } else {
            target = {
              kind: "thread-diff",
              threadId: thread.id,
              fromTurnCount: input.target.fromTurnCount,
              toTurnCount: input.target.toTurnCount,
            };
          }
          const author: DiffWalkthroughAuthor =
            caller === undefined
              ? {}
              : {
                  threadId: caller.id,
                  provider: caller.providerInstanceId,
                  model: caller.modelSelection.model,
                };
          const stored = yield* walkthroughs
            .put({
              target,
              ...(input.summary === undefined ? {} : { summary: input.summary }),
              groups: input.groups,
              notes: input.notes,
              generatedAt: DateTime.formatIso(yield* DateTime.now),
              author,
            })
            .pipe(Effect.mapError(rejected));
          const described =
            stored.target.kind === "pull-request"
              ? `pull request ${[stored.target.host, stored.target.repository].filter(Boolean).join("/")}#${stored.target.number} at ${stored.target.headSha.slice(0, 12)}`
              : `turns ${stored.target.fromTurnCount} to ${stored.target.toTurnCount} of thread ${stored.target.threadId}`;
          return {
            target: stored.target,
            groupCount: stored.groups.length,
            noteCount: stored.notes.length,
            confirmation: `Stored the walkthrough of ${described}.`,
          };
        }),
    ),
    read_thread_diff: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { thread } = yield* targetThread(input.threadId);
        const result = yield* diffs
          .getTurnDiff({
            threadId: thread.id,
            fromTurnCount: input.fromTurnCount,
            toTurnCount: input.toTurnCount,
            ...(input.ignoreWhitespace === undefined
              ? {}
              : { ignoreWhitespace: input.ignoreWhitespace }),
          })
          .pipe(Effect.mapError(diffReadFailed));
        const bounded = boundThreadDiff(result.diff, THREAD_DIFF_CHARACTER_LIMIT);
        return {
          threadId: thread.id,
          fromTurnCount: result.fromTurnCount,
          toTurnCount: result.toTurnCount,
          diff: bounded.diff,
          truncated: bounded.omittedFiles.length > 0,
          omittedFiles: bounded.omittedFiles,
        };
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof DiffWalkthroughToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(DiffWalkthroughToolkit, make);
