import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  DiffWalkthroughGetResult,
  DiffWalkthroughTarget,
  EnvironmentId,
} from "@t3tools/contracts";
import { useState } from "react";

import { generateDiffWalkthrough } from "~/state/diffWalkthrough";
import { useAtomCommand } from "~/state/use-atom-command";

import type { DiffWalkthroughBackground } from "./DiffWalkthroughView";
import { diffWalkthroughGenerateState } from "./diffWalkthroughView.logic";

/**
 * The walkthrough view's "Generate in background", from the subscription the host already
 * follows. A refused request shows where a failed run does, until the run or the revision moves.
 */
export function useDiffWalkthroughBackgroundRun({
  environmentId,
  liveTarget,
  result,
}: {
  environmentId: EnvironmentId | null;
  /** The diff at its current revision, which is what a run reads. Null while unknown. */
  liveTarget: DiffWalkthroughTarget | null;
  result: DiffWalkthroughGetResult | null;
}): DiffWalkthroughBackground {
  const canStart = useAtomValue(generateDiffWalkthrough.permissionAtom(environmentId));
  const generate = useAtomCommand(generateDiffWalkthrough, { reportFailure: false });
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState<{ key: string; message: string } | null>(null);

  const run = result?.run ?? null;
  const refusalKey = JSON.stringify([
    liveTarget,
    run === null ? null : run._tag === "Running" ? run.startedAt : run.failedAt,
  ]);
  const state = diffWalkthroughGenerateState({
    run,
    unavailable: result?.unavailable ?? null,
    liveTarget,
    starting,
    requestError: refusal?.key === refusalKey ? refusal.message : null,
  });

  const start = async () => {
    if (environmentId === null || liveTarget === null || starting) return;
    setStarting(true);
    setRefusal(null);
    const outcome = await generate({ environmentId, input: { target: liveTarget } });
    setStarting(false);
    if (outcome._tag === "Failure") {
      const failure = squashAtomCommandFailure(outcome);
      setRefusal({
        key: refusalKey,
        message:
          failure instanceof Error && failure.message.trim().length > 0
            ? failure.message
            : "The walkthrough could not start.",
      });
    }
  };

  return {
    state,
    onStart: canStart && environmentId !== null ? () => void start() : undefined,
  };
}
