import type { JiraCapabilities } from "@t3tools/contracts";

import { personalCredentialForSite } from "./jiraIssueList.logic";

/** The longest comment the server accepts, in characters of markdown. */
export const JIRA_COMMENT_MAX_LENGTH = 32_000;

export type JiraIssueWriteAccess = "enabled" | "needs-token" | "hidden";

/**
 * Whether the signed-in user may comment on, move, or break down issues of `site` as themselves.
 * Each needs their personal token for that site and the operate grant; a breakdown needs the token
 * because its proposal is approved with it. `needs-token` is shown only to a
 * session that can store a token at all; for anyone else the controls are simply absent.
 */
export function jiraIssueWriteAccess(input: {
  readonly capabilities: Pick<JiraCapabilities, "personalCredential" | "personalTokens"> | null;
  readonly canOperate: boolean;
  readonly site: string;
}): JiraIssueWriteAccess {
  const { capabilities } = input;
  if (capabilities === null || !input.canOperate) return "hidden";
  if (personalCredentialForSite(capabilities, input.site) !== null) return "enabled";
  return capabilities.personalTokens ? "needs-token" : "hidden";
}

/** The markdown to post, or null while the draft is empty or past the server's limit. */
export function jiraCommentToPost(draft: string): string | null {
  const body = draft.trim();
  return body.length === 0 || body.length > JIRA_COMMENT_MAX_LENGTH ? null : body;
}
