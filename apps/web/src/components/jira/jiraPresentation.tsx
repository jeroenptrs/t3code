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
export function JiraStatusBadge(props: { category: JiraStatusCategory; status?: string }) {
  return (
    <Badge variant={CATEGORY_BADGE_VARIANT[props.category]}>
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
