import type { JiraStatusCategory } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";

/** Jira colors statuses by category only: gray to do, blue in progress, green done. */
const CATEGORY_BADGE_VARIANT = {
  todo: "secondary",
  "in-progress": "info",
  done: "success",
} as const satisfies Record<JiraStatusCategory, "secondary" | "info" | "success">;

const CATEGORY_DOT_CLASS: Record<JiraStatusCategory, string> = {
  todo: "bg-muted-foreground/60",
  "in-progress": "bg-info",
  done: "bg-success",
};

export const JIRA_STATUS_CATEGORY_LABEL: Record<JiraStatusCategory, string> = {
  todo: "To do",
  "in-progress": "In progress",
  done: "Done",
};

/** The issue's own status name, colored by the category its workflow maps it to. */
export function JiraStatusBadge(props: {
  category: JiraStatusCategory;
  status?: string;
  size?: "sm" | "default";
}) {
  return (
    <Badge variant={CATEGORY_BADGE_VARIANT[props.category]} size={props.size ?? "default"}>
      {props.status ?? JIRA_STATUS_CATEGORY_LABEL[props.category]}
    </Badge>
  );
}

/** A row's status at a glance, for lists that only carry the shell snapshot. */
export function JiraStatusDot(props: { category: JiraStatusCategory | null }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        props.category === null
          ? "border border-muted-foreground/50"
          : CATEGORY_DOT_CLASS[props.category],
      )}
    />
  );
}

/**
 * How to give a server a Jira identity, for every surface that finds Jira off. The server reads
 * these at startup, so the last step is always a restart.
 */
export function JiraConfigurationSteps() {
  return (
    <>
      Set <code>T3CODE_JIRA_IDENTITIES</code> to one or more comma-separated identity names in the
      server's environment, and for each name set <code>T3CODE_JIRA_&lt;NAME&gt;_SITE</code> and{" "}
      <code>T3CODE_JIRA_&lt;NAME&gt;_TOKEN</code>, plus{" "}
      <code>T3CODE_JIRA_&lt;NAME&gt;_CLOUD_ID</code> for a scoped service-account token or{" "}
      <code>T3CODE_JIRA_&lt;NAME&gt;_EMAIL</code> for a classic API token. With several identities,{" "}
      <code>T3CODE_JIRA_READER</code> picks the one the app reads with. Then restart the server.
    </>
  );
}
