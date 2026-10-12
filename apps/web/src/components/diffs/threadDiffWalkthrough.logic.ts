import type {
  DiffWalkthroughBranchRangeTarget,
  ProjectId,
  ReviewDiffPreviewSource,
} from "@t3tools/contracts";
import { DIFF_WALKTHROUGH_GROUP_GUIDANCE } from "@t3tools/shared/pullRequestWalkthroughPrompt";

/**
 * The task the Diff panel puts in this thread's composer to have its agent write a walkthrough of
 * one checkpoint range. The thread is left implicit: both tools default to the thread they are
 * called from.
 */
export function buildThreadDiffWalkthroughPrompt(range: {
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
}): string {
  const { fromTurnCount, toTurnCount } = range;
  const scope =
    toTurnCount - fromTurnCount === 1
      ? `turn ${toTurnCount}'s changes`
      : `the changes of turns ${fromTurnCount + 1} to ${toTurnCount}`;
  return [
    `Write a walkthrough of ${scope} in this thread.`,
    `Read the diff with \`read_thread_diff\` (target kind \`thread-diff\`, fromTurnCount ${fromTurnCount}, toTurnCount ${toTurnCount}), and the surrounding code wherever it is needed to explain what a change does.`,
    `Then call \`write_diff_walkthrough\` with target kind \`thread-diff\`, fromTurnCount ${fromTurnCount} and toTurnCount ${toTurnCount}. Group every changed file by intent, in suggested reading order. Write one note per meaningful hunk with a one-line summary of what it does, and a markdown body only where the why or how is not obvious. Skip commentary on style and formatting.`,
    DIFF_WALKTHROUGH_GROUP_GUIDANCE,
    "Do not change any code.",
  ].join("\n\n");
}

/**
 * The same task for the branch this thread's checkout is on, from its merge base to HEAD. The
 * tools read the branch and both commits from the checkout, so the prompt names neither.
 */
export function buildBranchRangeWalkthroughPrompt(branch: string): string {
  return [
    `Write a walkthrough of the commits on branch \`${branch}\` in this thread's checkout.`,
    "Read the diff with `read_thread_diff` (target kind `branch-range`), and the surrounding code wherever it is needed to explain what a change does. The diff runs to the working tree, so it can include uncommitted changes; describe committed work only and leave those out.",
    "Then call `write_diff_walkthrough` with target kind `branch-range`. Group every committed changed file by intent, in suggested reading order. Write one note per meaningful hunk with a one-line summary of what it does, and a markdown body only where the why or how is not obvious. Skip commentary on style and formatting.",
    DIFF_WALKTHROUGH_GROUP_GUIDANCE,
    "Do not change any code, and do not commit.",
  ].join("\n\n");
}

/**
 * The walkthrough target of the Diff panel's branch scope, or why it has none: a detached HEAD
 * names no branch, and an unborn HEAD (or an older server) gives no commits to pin it to.
 */
export function branchRangeWalkthroughTarget(
  projectId: ProjectId,
  source: Pick<ReviewDiffPreviewSource, "headRef" | "baseSha" | "headSha">,
):
  | { readonly kind: "ready"; readonly target: DiffWalkthroughBranchRangeTarget }
  | { readonly kind: "unavailable"; readonly reason: string } {
  // headRef is the checked-out branch, or HEAD when detached; no branch can be named HEAD.
  if (source.headRef === null || source.headRef === "HEAD") {
    return { kind: "unavailable", reason: "Walkthroughs need a branch. HEAD is detached." };
  }
  if (source.baseSha === undefined || source.headSha === undefined) {
    return { kind: "unavailable", reason: "Walkthroughs need a branch with commits." };
  }
  return {
    kind: "ready",
    target: {
      kind: "branch-range",
      projectId,
      branch: source.headRef,
      baseSha: source.baseSha,
      headSha: source.headSha,
    },
  };
}
