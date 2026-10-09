import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type DiffWalkthroughTargetIdentity,
  type EnvironmentId,
} from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

const diffWalkthroughFamily = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:diff-walkthrough",
  tag: WS_METHODS.diffWalkthroughSubscribe,
});

/** Fixed field order: the family is keyed by the input's JSON, so equal targets share one stream. */
function canonicalTarget(target: DiffWalkthroughTargetIdentity): DiffWalkthroughTargetIdentity {
  switch (target.kind) {
    case "pull-request":
      return {
        kind: target.kind,
        projectId: target.projectId,
        ...(target.host === undefined ? {} : { host: target.host }),
        repository: target.repository,
        number: target.number,
      };
    case "thread-diff":
      return {
        kind: target.kind,
        threadId: target.threadId,
        fromTurnCount: target.fromTurnCount,
        toTurnCount: target.toTurnCount,
      };
  }
}

/** The stored walkthrough for a diff, then every replacement an agent writes. */
export function diffWalkthroughAtom(
  environmentId: EnvironmentId,
  target: DiffWalkthroughTargetIdentity,
) {
  return diffWalkthroughFamily({ environmentId, input: { target: canonicalTarget(target) } });
}
