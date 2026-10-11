import { ChevronDown, ChevronRight } from "lucide";
import type { MouseEvent } from "react";

import { MorphIcon } from "~/components/MorphIcon";

import { PullRequestDiffStat } from "../pullRequest/pullRequestPresentation";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The viewer's own per-file counts are hidden and drawn from this side of its shadow root
 * instead, by `DiffFileHeaderMetadata`: its counts are hunk sums, and a file whose hunks the host
 * withheld would read as an empty change rather than as the counts the host did report.
 */
export const REPLACE_FILE_COUNTS_CSS = `
[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  display: none !important;
}`;

/** The chevron before a file's name in the code view's header. */
export function DiffFileFoldButton({
  collapsed,
  onToggle,
}: {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <Button
      size="icon-micro"
      variant="ghost-muted"
      aria-expanded={!collapsed}
      aria-label={collapsed ? "Expand diff" : "Collapse diff"}
      className="mr-1"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <MorphIcon className="size-4" icon={collapsed ? ChevronRight : ChevronDown} />
    </Button>
  );
}

/**
 * A file's counts and, where the diff keeps viewed state, its Viewed tick, for the code view's
 * header metadata slot. `stale` says the file changed since it was ticked.
 */
export function DiffFileHeaderMetadata({
  additions,
  deletions,
  viewed,
}: {
  readonly additions: number;
  readonly deletions: number;
  readonly viewed?: {
    readonly viewed: boolean;
    readonly stale: boolean;
    readonly onViewedChange: (viewed: boolean) => void;
  };
}) {
  const stat = (
    <PullRequestDiffStat
      additions={additions}
      deletions={deletions}
      className="font-mono text-2xs"
    />
  );
  if (viewed === undefined) return stat;
  return (
    <span className="flex items-center gap-3">
      {stat}
      {/* The header itself folds the file, so the tick keeps its press to itself. The
          attribute is what the header's capture listener looks for. */}
      <label
        data-viewed-toggle=""
        className="flex cursor-pointer select-none items-center gap-1.5 text-2xs text-muted-foreground"
        onClick={(event) => event.stopPropagation()}
      >
        <Checkbox
          aria-label={viewed.stale ? "Changed" : "Viewed"}
          checked={viewed.viewed}
          onCheckedChange={(next) => viewed.onViewedChange(next === true)}
        />
        {viewed.stale ? (
          <Tooltip>
            <TooltipTrigger render={<span className="text-warning-foreground" />}>
              Changed
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              This file has been pushed to since you marked it viewed.
            </TooltipPopup>
          </Tooltip>
        ) : (
          <span className="@max-xs:hidden">Viewed</span>
        )}
      </label>
    </span>
  );
}

/**
 * The path of the file whose header row was pressed, for a capture listener on the code view's
 * wrapper that folds the file. The chevron answers this too, but the whole header row is the
 * target a reader actually aims for. The header lives in the viewer's shadow tree, so this walks
 * `composedPath`, the only way to see through the shadow boundary. Null for a press anywhere
 * else, and for one on a control inside the header, which handles itself.
 */
export function pressedDiffHeaderPath(event: MouseEvent): string | null {
  const composedPath = event.nativeEvent.composedPath?.() ?? [];
  for (const node of composedPath) {
    if (!(node instanceof HTMLElement)) continue;
    // The capture listener fires before the control's own click does, so answering here too
    // would make the two toggles cancel out.
    if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) return null;
    // A label answers for the control it names and the listener runs before it hears anything,
    // so leaving it alone keeps the header from folding what the tick folds.
    if (node.hasAttribute("data-viewed-toggle")) return null;
    if (node.hasAttribute("data-diffs-header")) {
      const filePath = node.querySelector("[data-title]")?.textContent?.trim();
      return filePath === undefined || filePath === "" ? null : filePath;
    }
  }
  return null;
}
