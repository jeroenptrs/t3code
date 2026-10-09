import type { DiffWalkthrough, DiffWalkthroughNote, EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, ChevronRightIcon, HistoryIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import ChatMarkdown from "../ChatMarkdown";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildDiffWalkthroughRail,
  diffWalkthroughGroupProgress,
  type DiffWalkthroughRailFile,
  type DiffWalkthroughRailGroup,
  type DiffWalkthroughRailNote,
} from "./diffWalkthroughRail.logic";

export interface DiffWalkthroughRailProps {
  /** Null once the environment has answered that there is none. */
  readonly walkthrough: DiffWalkthrough | null;
  /** True until the first answer arrives. */
  readonly loading: boolean;
  readonly error: string | null;
  /** The files the diff on screen changes; the walkthrough is shown against these. */
  readonly changedPaths: ReadonlyArray<string>;
  /** Absent where the diff has no viewed-file state, which hides the per-group progress. */
  readonly isFileViewed?: ((path: string) => boolean) | undefined;
  /** From `useDiffWalkthroughActiveEntry`: the entry the diff is showing. */
  readonly activeEntryKey: string | null;
  /** From `diffWalkthroughStaleNotice`: set when the walkthrough was written for another revision. */
  readonly staleNotice: string | null;
  readonly onRevealFile: (path: string) => void;
  readonly onRevealNote: (note: DiffWalkthroughNote) => void;
  /** Offers to write a walkthrough, or a fresh one in place of a stale one. */
  readonly onGenerate?: (() => void) | undefined;
  /** For links in note bodies. */
  readonly cwd: string | undefined;
  readonly environmentId: EnvironmentId | undefined;
  /** Rendered under the rail, for a diff that still has files to fetch. */
  readonly footer?: ReactNode;
}

/**
 * An agent's guide to the diff beside it: groups of files in the order to read them, with a line
 * on each hunk worth reading. Picking an entry scrolls the diff to it; the entry the diff is on
 * stays marked.
 */
export function DiffWalkthroughRail({
  walkthrough,
  loading,
  error,
  changedPaths,
  isFileViewed,
  activeEntryKey,
  staleNotice,
  onRevealFile,
  onRevealNote,
  onGenerate,
  cwd,
  environmentId,
  footer,
}: DiffWalkthroughRailProps) {
  const model = useMemo(
    () => (walkthrough === null ? null : buildDiffWalkthroughRail(walkthrough, changedPaths)),
    [changedPaths, walkthrough],
  );
  // Only the group holding the active entry re-renders when it moves.
  const groupOfEntry = useMemo(() => {
    const groups = new Map<string, string>();
    for (const group of model?.groups ?? []) {
      for (const file of group.files) {
        groups.set(file.key, group.id);
        for (const note of file.notes) groups.set(note.key, group.id);
      }
    }
    return groups;
  }, [model]);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activeEntryKey === null) return;
    listRef.current
      ?.querySelector(`[data-walkthrough-entry="${CSS.escape(activeEntryKey)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeEntryKey]);

  const activeGroupId = activeEntryKey === null ? undefined : groupOfEntry.get(activeEntryKey);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 text-xs text-muted-foreground"
        data-surface-subheader
      >
        <span className="px-1 font-medium text-foreground">Walkthrough</span>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {model === null ? (
          loading ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">Loading walkthrough...</p>
          ) : error !== null ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">{error}</p>
          ) : (
            <Empty size="compact">
              <EmptyHeader>
                <EmptyTitle>No walkthrough yet</EmptyTitle>
                <EmptyDescription>
                  An agent can group these files by intent and say what each change is for.
                </EmptyDescription>
              </EmptyHeader>
              {onGenerate === undefined ? null : (
                <EmptyContent>
                  <Button type="button" size="sm" variant="outline" onClick={onGenerate}>
                    Generate walkthrough
                  </Button>
                </EmptyContent>
              )}
            </Empty>
          )
        ) : (
          <>
            {staleNotice === null ? null : (
              <div className="p-2">
                <Alert variant="warning" controlAlignment="first-line">
                  <HistoryIcon />
                  <AlertTitle>{staleNotice}</AlertTitle>
                  <AlertDescription>The pull request has changed since.</AlertDescription>
                  {onGenerate === undefined ? null : (
                    <AlertAction>
                      <Button type="button" size="xs" variant="outline" onClick={onGenerate}>
                        Regenerate
                      </Button>
                    </AlertAction>
                  )}
                </Alert>
              </div>
            )}
            <div className={cn(staleNotice !== null && "opacity-60")}>
              {model.summary === null ? null : (
                <p className="border-b border-border/60 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
                  {model.summary}
                </p>
              )}
              {model.groups.map((group) => (
                <RailGroup
                  key={group.id}
                  group={group}
                  activeEntryKey={activeGroupId === group.id ? activeEntryKey : null}
                  isFileViewed={isFileViewed}
                  onRevealFile={onRevealFile}
                  onRevealNote={onRevealNote}
                  cwd={cwd}
                  environmentId={environmentId}
                />
              ))}
            </div>
          </>
        )}
      </div>
      {footer}
    </div>
  );
}

interface RailGroupProps {
  readonly group: DiffWalkthroughRailGroup;
  readonly activeEntryKey: string | null;
  readonly isFileViewed: ((path: string) => boolean) | undefined;
  readonly onRevealFile: (path: string) => void;
  readonly onRevealNote: (note: DiffWalkthroughNote) => void;
  readonly cwd: string | undefined;
  readonly environmentId: EnvironmentId | undefined;
}

const RailGroup = memo(function RailGroup({
  group,
  activeEntryKey,
  isFileViewed,
  onRevealFile,
  onRevealNote,
  cwd,
  environmentId,
}: RailGroupProps) {
  const progress =
    isFileViewed === undefined ? null : diffWalkthroughGroupProgress(group, isFileViewed);
  return (
    <section className="border-b border-border/60 py-2">
      <div className="flex items-baseline gap-2 px-3">
        {group.ordinal === null ? null : (
          <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-3xs font-medium tabular-nums text-muted-foreground">
            {group.ordinal}
          </span>
        )}
        <h3 className="min-w-0 flex-1 text-xs font-medium text-foreground">{group.title}</h3>
        {progress === null ? null : (
          <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
            {progress.viewed}/{progress.total} viewed
          </span>
        )}
      </div>
      <p className="mt-1 px-3 text-xs leading-5 text-muted-foreground">{group.summary}</p>
      <ul className="mt-1.5">
        {group.files.map((file) => (
          <RailFile
            key={file.key}
            file={file}
            activeEntryKey={activeEntryKey}
            viewed={isFileViewed?.(file.path) ?? false}
            onRevealFile={onRevealFile}
            onRevealNote={onRevealNote}
            cwd={cwd}
            environmentId={environmentId}
          />
        ))}
      </ul>
    </section>
  );
});

function RailFile({
  file,
  activeEntryKey,
  viewed,
  onRevealFile,
  onRevealNote,
  cwd,
  environmentId,
}: {
  readonly file: DiffWalkthroughRailFile;
  readonly activeEntryKey: string | null;
  readonly viewed: boolean;
  readonly onRevealFile: (path: string) => void;
  readonly onRevealNote: (note: DiffWalkthroughNote) => void;
  readonly cwd: string | undefined;
  readonly environmentId: EnvironmentId | undefined;
}) {
  const slash = file.path.lastIndexOf("/");
  return (
    <li>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={cn(
                "flex w-full items-center gap-1.5 px-3 py-1 text-left font-mono text-2xs hover:bg-accent/60",
                activeEntryKey === file.key && "bg-accent text-accent-foreground",
              )}
              data-walkthrough-entry={file.key}
              aria-current={activeEntryKey === file.key ? "location" : undefined}
              onClick={() => onRevealFile(file.path)}
            />
          }
        >
          <span className="min-w-0 flex-1 truncate">
            {slash === -1 ? null : (
              <span className="text-muted-foreground">{file.path.slice(0, slash + 1)}</span>
            )}
            <span className="text-foreground">{file.path.slice(slash + 1)}</span>
          </span>
          {viewed ? (
            <CheckIcon aria-label="Viewed" className="size-3 shrink-0 text-muted-foreground" />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="left">{file.path}</TooltipPopup>
      </Tooltip>
      {file.notes.length === 0 ? null : (
        <ul className="pb-1">
          {file.notes.map((entry) => (
            <RailNote
              key={entry.key}
              entry={entry}
              active={activeEntryKey === entry.key}
              onRevealNote={onRevealNote}
              cwd={cwd}
              environmentId={environmentId}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function noteLinesLabel(note: DiffWalkthroughNote): string {
  const lines =
    note.startLine === note.endLine ? `L${note.startLine}` : `L${note.startLine}-${note.endLine}`;
  return note.side === "deletions" ? `old ${lines}` : lines;
}

function RailNote({
  entry,
  active,
  onRevealNote,
  cwd,
  environmentId,
}: {
  readonly entry: DiffWalkthroughRailNote;
  readonly active: boolean;
  readonly onRevealNote: (note: DiffWalkthroughNote) => void;
  readonly cwd: string | undefined;
  readonly environmentId: EnvironmentId | undefined;
}) {
  const { note } = entry;
  const row = (
    <button
      type="button"
      className="flex min-w-0 flex-1 items-baseline gap-2 py-1 text-left text-xs"
      data-walkthrough-entry={entry.key}
      aria-current={active ? "location" : undefined}
      onClick={() => onRevealNote(note)}
    >
      <span className="shrink-0 font-mono text-3xs tabular-nums text-muted-foreground">
        {noteLinesLabel(note)}
      </span>
      <span className="min-w-0 flex-1 text-foreground">{note.summary}</span>
    </button>
  );
  const rowClassName = cn(
    "ml-4 flex items-start gap-1 border-l border-border/60 pr-2 pl-2 hover:bg-accent/60",
    active && "border-primary bg-accent",
  );
  if (note.body === undefined) {
    return <li className={rowClassName}>{row}</li>;
  }
  // Collapsed by default; the panel mounts the markdown only once it is opened.
  return (
    <li>
      <Collapsible>
        <div className={rowClassName}>
          {row}
          <CollapsibleTrigger
            render={
              <Button type="button" size="icon-xs" variant="ghost" aria-label="Explanation" />
            }
          >
            <ChevronRightIcon className="transition-transform motion-reduce:transition-none in-data-panel-open:rotate-90" />
          </CollapsibleTrigger>
        </div>
        <CollapsiblePanel>
          <div className="ml-4 border-l border-border/60 py-1 pr-3 pl-3 text-xs">
            <ChatMarkdown text={note.body} cwd={cwd} environmentId={environmentId} />
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </li>
  );
}
