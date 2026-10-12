import type {
  DiffWalkthroughBranchRangeTarget,
  DiffWalkthroughPullRequestTarget,
  DiffWalkthroughTarget,
  DiffWalkthroughThreadDiffTarget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { type DiffChange, diffSectionPaths, parseDiffChange } from "../review/diffChange.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { PATCH_RENDER_PREFIX_ARGS } from "../vcs/GitVcsDriverCore.ts";

/**
 * What a walkthrough's notes are held to, or why they cannot be. `withheld` names changed files
 * whose lines the host did not serve, so notes on them stand as written.
 */
export type DiffWalkthroughChange =
  | {
      readonly held: true;
      readonly change: DiffChange;
      readonly withheld: ReadonlySet<string>;
    }
  | { readonly held: false; readonly reason: string };

/** A host serves a diff a slice at a time; past this many the change is not checked. */
const MAX_PULL_REQUEST_DIFF_SLICES = 100;

/** Revisions reach `git diff` as arguments, so only something shaped like a commit SHA does. */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

const unheld = (reason: string): DiffWalkthroughChange => ({ held: false, reason });

/** Reads the change a walkthrough target describes. Never fails: an unreadable one is unheld. */
export class DiffWalkthroughChangeReader extends Context.Service<
  DiffWalkthroughChangeReader,
  {
    readonly read: (target: DiffWalkthroughTarget) => Effect.Effect<DiffWalkthroughChange>;
  }
>()("t3/diffWalkthrough/DiffWalkthroughChangeReader") {}

const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projects = yield* ProjectService.ProjectService;
  const checkpoints = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const pullRequests = yield* PullRequestService.PullRequestService;

  /** The changed paths and the lines each touched between two local revisions. */
  const readRange = Effect.fn("DiffWalkthroughChangeReader.readRange")(function* (
    cwd: string,
    from: string,
    to: string,
  ) {
    const diff = (args: ReadonlyArray<string>) =>
      git
        .execute({
          operation: "DiffWalkthroughChangeReader.readRange",
          cwd,
          // Fixed prefixes: a user's diff.noPrefix or custom prefixes would hide the headers the
          // parser reads.
          args: [
            "-c",
            "core.quotePath=false",
            "diff",
            ...PATCH_RENDER_PREFIX_ARGS,
            ...args,
            `${from}^{commit}`,
            `${to}^{commit}`,
          ],
          timeoutMs: 60_000,
          // Hunk headers only, but a large change still has many of them.
          maxOutputBytes: 64 * 1024 * 1024,
        })
        .pipe(Effect.map((result) => result.stdout));
    const [nameOnly, patch] = yield* Effect.all(
      [diff(["--name-only", "-z"]), diff(["--unified=0", "--no-color", "--no-ext-diff"])],
      { concurrency: "unbounded" },
    );
    return {
      held: true,
      change: parseDiffChange(nameOnly, patch),
      withheld: new Set(),
    } satisfies DiffWalkthroughChange;
  });

  /** Branch commits are shared by every worktree of a repository, so the project's root reads them. */
  const readBranchRange = Effect.fn("DiffWalkthroughChangeReader.readBranchRange")(function* (
    target: DiffWalkthroughBranchRangeTarget,
  ) {
    if (!COMMIT_SHA.test(target.baseSha) || !COMMIT_SHA.test(target.headSha)) {
      return unheld("The branch range's baseSha and headSha are not commit SHAs.");
    }
    const project = Option.getOrUndefined(yield* projects.getShell(target.projectId));
    if (project === undefined) return unheld("The project was not found.");
    return yield* readRange(project.workspaceRoot, target.baseSha, target.headSha);
  });

  const readThreadDiff = Effect.fn("DiffWalkthroughChangeReader.readThreadDiff")(function* (
    target: DiffWalkthroughThreadDiffTarget,
  ) {
    if (target.fromTurnCount === target.toTurnCount) {
      return {
        held: true,
        change: { files: [], hunks: new Map() },
        withheld: new Set(),
      } satisfies DiffWalkthroughChange;
    }
    const range = yield* checkpoints.resolveTurnRange(target);
    return yield* readRange(range.cwd, range.fromCheckpointRef, range.toCheckpointRef);
  });

  /**
   * The diff the server serves for the pull request, whole. Its hunks carry the host's context
   * lines, so a note on those is kept. Only the current head's diff is served, so a walkthrough
   * written against another head is not checked against it.
   */
  const readPullRequest = Effect.fn("DiffWalkthroughChangeReader.readPullRequest")(function* (
    target: DiffWalkthroughPullRequestTarget,
  ) {
    const reference = {
      projectId: target.projectId,
      ...(target.host === undefined ? {} : { host: target.host }),
      repository: target.repository,
      number: target.number,
    };
    const headSha = (yield* pullRequests.detail(reference)).headSha;
    if (headSha === undefined) return unheld("The host did not report the pull request's head.");
    if (headSha.toLowerCase() !== target.headSha.toLowerCase()) {
      return unheld(
        `The pull request's head is now ${headSha.slice(0, 12)}, not ${target.headSha.slice(0, 12)}, so its diff is another revision.`,
      );
    }
    const patches: Array<string> = [];
    const withheld = new Set<string>();
    let cursor: string | undefined;
    for (let slice = 0; ; slice += 1) {
      if (slice === MAX_PULL_REQUEST_DIFF_SLICES) {
        return unheld("The pull request's diff is too large to check notes against.");
      }
      const page = yield* pullRequests.diff({
        ...reference,
        ...(cursor === undefined ? {} : { cursor }),
      });
      patches.push(page.patch);
      for (const stat of page.omittedFileStats ?? []) withheld.add(stat.path);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    // Slices are whole files; a blank line between two is outside any hunk.
    const patch = patches.join("\n");
    const files = diffSectionPaths(patch);
    const change = parseDiffChange(files.join("\0"), patch);
    // A binary file, or one whose hunks the host declined to inline, has none to hold a note to.
    for (const path of files) {
      const hunks = change.hunks.get(path);
      if (hunks === undefined || hunks.new.length + hunks.old.length === 0) withheld.add(path);
    }
    return { held: true, change, withheld } satisfies DiffWalkthroughChange;
  });

  const read: DiffWalkthroughChangeReader["Service"]["read"] = (target) => {
    switch (target.kind) {
      case "branch-range":
        return readBranchRange(target).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not read a branch range's change", { cause }).pipe(
              Effect.as(unheld("Could not read the branch's diff.")),
            ),
          ),
        );
      case "thread-diff":
        return readThreadDiff(target).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not read a thread diff's change", { cause }).pipe(
              Effect.as(
                unheld(
                  cause._tag === "CheckpointTurnRangeUnavailableError" ||
                    cause._tag === "CheckpointRefUnavailableError"
                    ? cause.message
                    : "Could not read the thread's diff.",
                ),
              ),
            ),
          ),
        );
      case "pull-request":
        return readPullRequest(target).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not read a pull request's change", { cause }).pipe(
              Effect.as(unheld("Could not read the pull request's diff from the host.")),
            ),
          ),
        );
    }
  };

  return DiffWalkthroughChangeReader.of({ read });
});

export const layer = Layer.effect(DiffWalkthroughChangeReader, make);
