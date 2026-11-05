import type { EnvironmentId, FactorySummary } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, FactoryIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { FactoryAttentionBadge } from "./FactoryAttentionBadge";

/** The factory's sidebar tree row; rows under it name it as their parent. */
export function sidebarFactoryRowId(environmentId: EnvironmentId, factoryId: string) {
  return `factory:${environmentId}:${factoryId}`;
}

/**
 * A factory in the Factories tab. The row opens the factory page; the chevron shows what the
 * factory owns below it.
 */
export function SidebarFactoryRow(props: {
  readonly environmentId: EnvironmentId;
  readonly factory: FactorySummary;
  readonly projectTitle: string | null;
  readonly active: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  const { factory } = props;
  return (
    <li className="list-none">
      <div
        className={cn(
          "flex h-8 items-center gap-1 rounded-(--control-radius) pe-1.5",
          props.active ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
      >
        <button
          type="button"
          aria-expanded={props.expanded}
          aria-label={
            props.expanded ? `Hide what ${factory.name} owns` : `Show what ${factory.name} owns`
          }
          onClick={props.onToggle}
          className="grid h-full w-6 shrink-0 cursor-pointer place-items-center rounded-(--control-radius) text-sidebar-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3 transition-transform", !props.expanded && "-rotate-90")}
          />
        </button>
        <Link
          to="/factories/$environmentId/$factoryId"
          params={{ environmentId: props.environmentId, factoryId: factory.id }}
          aria-current={props.active ? "page" : undefined}
          data-sidebar-row={sidebarFactoryRowId(props.environmentId, factory.id)}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-(--control-radius) text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <FactoryIcon aria-hidden className="size-4 shrink-0 text-(--sidebar-icon-color)" />
          <span className="min-w-0 truncate font-medium text-sidebar-foreground/90">
            {factory.name}
          </span>
          {props.projectTitle === null ? null : (
            <span className="min-w-0 truncate text-xs text-sidebar-muted-foreground">
              {props.projectTitle}
            </span>
          )}
        </Link>
        <FactoryAttentionBadge count={factory.attention.total} />
      </div>
      {props.expanded ? (
        <ul role="presentation" className="flex flex-col gap-px ps-3">
          {props.children}
        </ul>
      ) : null}
    </li>
  );
}
