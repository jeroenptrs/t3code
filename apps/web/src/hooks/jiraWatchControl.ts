import type { JiraIdentity } from "@t3tools/contracts";

export type JiraWatchControl =
  /** Nothing to show: not watched, and a watch could not be started or read. */
  | "none"
  /** Not watched; offer to start. */
  | "start"
  /** Watched; offer to stop. */
  | "stop"
  /** Watched, but the session cannot change it. */
  | "indicator";

/**
 * What the watch control on one linked issue should be. Starting needs the operate grant and a
 * server identity for the issue's site, since a watch on any other site is never read. An
 * existing watch always shows its state; stopping it needs only the grant.
 */
export function jiraWatchControl(input: {
  readonly site: string;
  readonly watching: boolean;
  readonly canOperate: boolean;
  readonly identities: ReadonlyArray<Pick<JiraIdentity, "site">>;
}): JiraWatchControl {
  if (input.watching) return input.canOperate ? "stop" : "indicator";
  if (!input.canOperate) return "none";
  const site = input.site.toLowerCase();
  return input.identities.some((identity) => identity.site.toLowerCase() === site)
    ? "start"
    : "none";
}
