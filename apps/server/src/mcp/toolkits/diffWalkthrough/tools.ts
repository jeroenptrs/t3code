import {
  DiffWalkthroughGroup,
  DiffWalkthroughNote,
  DiffWalkthroughTarget,
  NonNegativeInt,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  PullRequestHostRequiredError,
  PullRequestTargetIncompleteError,
  PullRequestTargetInput,
  PullRequestUrlInvalidError,
} from "../pullRequests/tools.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];

/** The service refused or failed to store the walkthrough; the message says what to fix. */
export class DiffWalkthroughRejectedError extends Schema.TaggedError<DiffWalkthroughRejectedError>()(
  "DiffWalkthroughRejectedError",
  { message: Schema.String },
) {}

export class ThreadDiffReadFailedError extends Schema.TaggedError<ThreadDiffReadFailedError>()(
  "ThreadDiffReadFailedError",
  { message: Schema.String },
) {}

const TurnCountFields = {
  fromTurnCount: NonNegativeInt.annotate({
    description: "Turn count the diff starts from. 0 is the thread's starting point.",
  }),
  toTurnCount: NonNegativeInt.annotate({
    description: "Turn count the diff ends at, at least fromTurnCount.",
  }),
};

const WalkthroughPullRequestTargetInput = Schema.Struct({
  kind: Schema.Literal("pull-request"),
  ...PullRequestTargetInput.fields,
  threadId: Schema.optional(
    ThreadId.annotate({
      description: "Thread whose project the pull request belongs to. Omit for this thread.",
    }),
  ),
  headSha: TrimmedNonEmptyString.annotate({
    description:
      "Full SHA of the pull request head commit you read, for example from `gh pr view <number> --json headRefOid`.",
  }),
});

const WalkthroughThreadDiffTargetInput = Schema.Struct({
  kind: Schema.Literal("thread-diff"),
  threadId: Schema.optional(
    ThreadId.annotate({
      description: "Thread whose checkpoint diff this is. Omit for this thread.",
    }),
  ),
  ...TurnCountFields,
});

export const WriteDiffWalkthroughInput = Schema.Struct({
  target: Schema.Union([WalkthroughPullRequestTargetInput, WalkthroughThreadDiffTargetInput]),
  summary: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(2000)).annotate({
      description: "The change as a whole, in a short paragraph.",
    }),
  ),
  groups: Schema.Array(
    Schema.Struct({
      id: DiffWalkthroughGroup.fields.id.annotate({
        description: "Short id that notes refer to, for example storage.",
      }),
      title: DiffWalkthroughGroup.fields.title,
      summary: DiffWalkthroughGroup.fields.summary.annotate({
        description: "The intent behind these files, in a sentence or two.",
      }),
      files: DiffWalkthroughGroup.fields.files.annotate({
        description: "Changed file paths as the diff names them; the new path for a rename.",
      }),
    }),
  ).annotate({ description: "In suggested reading order." }),
  notes: Schema.Array(
    Schema.Struct({
      groupId: DiffWalkthroughNote.fields.groupId,
      path: DiffWalkthroughNote.fields.path,
      side: DiffWalkthroughNote.fields.side.annotate({
        description:
          "additions: line numbers of the new file (also for unchanged context). deletions: line numbers of the old file, for removed code.",
      }),
      startLine: DiffWalkthroughNote.fields.startLine,
      endLine: DiffWalkthroughNote.fields.endLine,
      summary: DiffWalkthroughNote.fields.summary.annotate({
        description: "One line: what this hunk does.",
      }),
      body: Schema.optional(
        Schema.String.check(Schema.isMaxLength(8000)).annotate({
          description: "Optional markdown: why or how, relative to the surrounding code.",
        }),
      ),
    }),
  ).annotate({ description: "In reading order within each file." }),
});
export type WriteDiffWalkthroughInput = typeof WriteDiffWalkthroughInput.Type;

export const WriteDiffWalkthroughResult = Schema.Struct({
  target: DiffWalkthroughTarget,
  groupCount: Schema.Int,
  noteCount: Schema.Int,
  confirmation: Schema.String,
});
export type WriteDiffWalkthroughResult = typeof WriteDiffWalkthroughResult.Type;

export const ReadThreadDiffInput = Schema.Struct({
  threadId: Schema.optional(
    ThreadId.annotate({ description: "Thread to read. Omit for this thread." }),
  ),
  ...TurnCountFields,
  ignoreWhitespace: Schema.optional(
    Schema.Boolean.annotate({ description: "Hide whitespace-only changes. Defaults to true." }),
  ),
});
export type ReadThreadDiffInput = typeof ReadThreadDiffInput.Type;

export const ReadThreadDiffResult = Schema.Struct({
  threadId: ThreadId,
  fromTurnCount: Schema.Int,
  toTurnCount: Schema.Int,
  diff: Schema.String.annotate({ description: "Unified diff, whole files only." }),
  truncated: Schema.Boolean,
  omittedFiles: Schema.Array(Schema.String).annotate({
    description: "Files left out of diff because it reached the size limit.",
  }),
});
export type ReadThreadDiffResult = typeof ReadThreadDiffResult.Type;

const WriteDiffWalkthroughTool = Tool.make("write_diff_walkthrough", {
  description: [
    "Store a walkthrough (code tour) of a pull request or of a thread's checkpoint diff. T3 Code shows it beside the diff, and it replaces any earlier walkthrough for the same pull request or turn range.",
    "groups are in suggested reading order, and each states the intent behind its files. Put EVERY changed file in exactly one group; files you leave out show under Other.",
    "notes anchor to a line range of one file in its group, numbered on the new side (additions) unless they describe deleted code (deletions). A note's summary is ONE line on what the hunk does: behavior, not style. body is optional markdown on why or how relative to the surrounding codebase; add it only when it says something the summary and the diff do not.",
    "For a pull request, headSha must be the head commit you actually read (`gh pr view <number> --json headRefOid`): T3 Code marks the walkthrough stale when the pull request head moves.",
    "For a thread diff, use read_thread_diff to read the same turn range first.",
  ].join(" "),
  parameters: WriteDiffWalkthroughInput,
  success: WriteDiffWalkthroughResult,
  failure: Schema.Union([
    OrchestratorMcpFailure,
    PullRequestUrlInvalidError,
    PullRequestTargetIncompleteError,
    PullRequestHostRequiredError,
    DiffWalkthroughRejectedError,
  ]),
  dependencies,
})
  .annotate(Tool.Title, "Write diff walkthrough")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReadThreadDiffTool = Tool.make("read_thread_diff", {
  description:
    "Read a thread's checkpoint diff as a unified diff. Turn counts number the thread's completed turns: turn N's changes are fromTurnCount N-1 to toTurnCount N, and the whole thread's changes are 0 to the latest turn. Large diffs are cut at a file boundary and list the files left out. Pairs with write_diff_walkthrough for a thread-diff walkthrough.",
  parameters: ReadThreadDiffInput,
  success: ReadThreadDiffResult,
  failure: Schema.Union([OrchestratorMcpFailure, ThreadDiffReadFailedError]),
  dependencies,
})
  .annotate(Tool.Title, "Read thread diff")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const DiffWalkthroughToolkit = Toolkit.make(WriteDiffWalkthroughTool, ReadThreadDiffTool);
