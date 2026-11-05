import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { HouseIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";
import { resolveSidebarTopStatus, TopStatusIcon } from "./SidebarThreadRow";

/**
 * The fixed row for the current Home thread, above every other row. Home has
 * no project, settle, or pin affordances, so it only shows its status.
 */
export const SidebarHomeRow = memo(function SidebarHomeRow(props: {
  readonly threadRef: ScopedThreadRef;
  readonly isActive: boolean;
  readonly onActivate: (threadRef: ScopedThreadRef) => void;
}) {
  const { isActive, onActivate, threadRef } = props;
  const thread = useThreadShell(threadRef);
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const topStatus =
    thread === null
      ? null
      : resolveSidebarTopStatus({
          status: resolveSidebarThreadStatus(thread),
          goalActive: thread.goal?.status === "active",
          isWoke: false,
          isUnread: hasUnseenCompletion({
            ...thread,
            lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
          }),
        });
  const activate = () => onActivate(threadRef);
  return (
    <li className="list-none py-0.5">
      <div
        role="button"
        tabIndex={0}
        aria-label={topStatus ? `Home, ${topStatus.label}` : "Home"}
        aria-current={isActive ? "page" : undefined}
        data-testid="sidebar-home-row"
        className={cn(
          "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-(--sidebar-row-content-inset) text-left text-sm font-medium outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          activate();
        }}
      >
        <HouseIcon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Home</span>
        {topStatus ? (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 text-xs font-medium",
              topStatus.className,
            )}
          >
            <TopStatusIcon icon={topStatus.icon} className="size-4" />
            <span role="status">{topStatus.label}</span>
          </span>
        ) : null}
      </div>
    </li>
  );
});
