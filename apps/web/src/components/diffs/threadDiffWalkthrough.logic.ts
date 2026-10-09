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
    `Read the diff with \`read_thread_diff\` (fromTurnCount ${fromTurnCount}, toTurnCount ${toTurnCount}), and the surrounding code wherever it is needed to explain what a change does.`,
    `Then call \`write_diff_walkthrough\` with target kind \`thread-diff\`, fromTurnCount ${fromTurnCount} and toTurnCount ${toTurnCount}. Group every changed file by intent, in suggested reading order. Write one note per meaningful hunk with a one-line summary of what it does, and a markdown body only where the why or how is not obvious. Skip commentary on style and formatting.`,
    "Do not change any code.",
  ].join("\n\n");
}
