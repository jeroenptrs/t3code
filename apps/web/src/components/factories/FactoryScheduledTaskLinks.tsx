import type { EnvironmentId, ScheduledTaskId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { CalendarClockIcon } from "lucide-react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { scheduleLabel } from "../settings/ScheduledTasksSettings";

/** A factory's scheduled tasks, each opening its editor in Settings. Mounted only while shown. */
export function FactoryScheduledTaskLinks(props: {
  readonly environmentId: EnvironmentId;
  /** The factory's tree row. */
  readonly parentRow: string;
  readonly scheduledTaskIds: ReadonlyArray<ScheduledTaskId>;
}) {
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
  ).data?.tasks;
  if (tasks === undefined) return null;
  return props.scheduledTaskIds.flatMap((taskId) => {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) return [];
    return [
      <li key={taskId} className="list-none">
        <Link
          to="/settings/scheduled-tasks"
          search={{ environmentId: props.environmentId, taskId }}
          data-sidebar-row={`scheduled-task:${props.environmentId}:${taskId}`}
          data-sidebar-parent={props.parentRow}
          className="flex h-8 min-w-0 items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-sm text-sidebar-foreground/90 outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <CalendarClockIcon aria-hidden className="size-4 shrink-0 text-(--sidebar-icon-color)" />
          <span className="min-w-0 flex-1 truncate">{task.title}</span>
          <span className="max-w-1/2 truncate text-xs text-sidebar-muted-foreground">
            {scheduleLabel(task.schedule)}
          </span>
        </Link>
      </li>,
    ];
  });
}
