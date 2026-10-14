import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type JiraIssueKey,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { useJiraCapabilities } from "~/state/jira";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

/**
 * Jira linking for one environment. Linking needs Jira configured there, since the dialog checks
 * the issue through the reader first; unlinking is only a thread command, so it stays available
 * for links made while Jira was configured, and so is stopping a watch. All need the session's
 * operate grant, as every orchestration command does.
 */
export function useJiraIssueLinking(environmentId: EnvironmentId | null) {
  const capabilities = useJiraCapabilities(environmentId);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const link = useAtomCommand(threadEnvironment.linkJiraIssue, { reportFailure: false });
  const unlink = useAtomCommand(threadEnvironment.unlinkJiraIssue, { reportFailure: true });
  return useMemo(() => {
    const configured = capabilities?.configured === true;
    const changeLink = async (threadRef: ScopedThreadRef, issue: JiraIssueKey, linked: boolean) => {
      const input = { threadId: threadRef.threadId, site: issue.site, key: issue.key };
      const result = await (linked
        ? link({
            environmentId: threadRef.environmentId,
            input: { ...input, source: "manual" },
          })
        : unlink({ environmentId: threadRef.environmentId, input }));
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) throw new Error("Link update interrupted.");
        throw squashAtomCommandFailure(result);
      }
    };
    return {
      capabilities,
      configured,
      /** Where a bare key lives: the reader identity's site. */
      defaultSite: capabilities?.reader?.site ?? null,
      canLink: configured && canOperate,
      canUnlink: canOperate,
      /** Starting a watch needs the same Jira read the sweep makes; stopping one never does. */
      canWatch: configured && canOperate,
      changeLink,
    };
  }, [canOperate, capabilities, link, unlink]);
}
