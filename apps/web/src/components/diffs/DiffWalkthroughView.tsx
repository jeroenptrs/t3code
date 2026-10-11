import type { CodeViewItem, FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import type { CodeViewDiffItem, CodeViewHandle } from "@pierre/diffs/react";
import type { DiffWalkthrough, DiffWalkthroughNote, EnvironmentId } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  HistoryIcon,
} from "lucide-react";
import { memo, useCallback, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { fnv1a32, resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";

import ChatMarkdown from "../ChatMarkdown";
import { DiffPanelLoadingState } from "../DiffPanelShell";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  DiffFileFoldButton,
  DiffFileHeaderMetadata,
  pressedDiffHeaderPath,
  REPLACE_FILE_COUNTS_CSS,
} from "./DiffFileHeaderControls";
import {
  buildDiffWalkthroughSections,
  clampDiffWalkthroughSectionIndex,
  firstUnreviewedSectionIndex,
  formatDiffWalkthroughNoteRange,
  formatDiffWalkthroughOrdinal,
  isDiffWalkthroughSectionReviewed,
  sectionIndexAfterReview,
  unviewedSectionFiles,
  type DiffWalkthroughSection,
  type DiffWalkthroughSectionNote,
} from "./diffWalkthroughView.logic";
import { StyledDiffCodeView } from "./StyledDiffCodeView";
import { useCodeViewFileReveal } from "./useCodeViewFileReveal";

/** The walkthrough itself, as far as the caller has it. */
export type DiffWalkthroughViewSource =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "empty" }
  | {
      readonly kind: "ready";
      readonly walkthrough: DiffWalkthrough;
      /** From `diffWalkthroughStaleNotice`: set when it was written for another revision. */
      readonly staleNotice: string | null;
    };

/** One changed file of the diff the walkthrough describes, parsed for the code view. */
export interface DiffWalkthroughViewFile {
  /** The code view's item id, `buildFileDiffRenderKey` of the file. */
  readonly key: string;
  readonly path: string;
  readonly fileDiff: FileDiffMetadata;
  readonly additions: number;
  readonly deletions: number;
}

/** The diff's files, which the sections need whole before they can be numbered. */
export type DiffWalkthroughViewFiles =
  | { readonly kind: "loading"; readonly label: string }
  | { readonly kind: "error"; readonly message: string; readonly onRetry?: () => void }
  | { readonly kind: "ready"; readonly files: ReadonlyArray<DiffWalkthroughViewFile> };

/** Per-file viewed state, shared with whatever other view of the diff keeps it. */
export interface DiffWalkthroughViewedFiles {
  readonly isViewed: (path: string) => boolean;
  /** The file changed since it was marked viewed. */
  readonly isStale?: (path: string) => boolean;
  readonly setViewed: (path: string, viewed: boolean) => void;
}

/** The step actions, for keybindings held outside the view. */
export interface DiffWalkthroughViewHandle {
  readonly previous: () => void;
  readonly next: () => void;
  readonly markReviewedAndContinue: () => void;
}

export interface DiffWalkthroughViewProps {
  readonly source: DiffWalkthroughViewSource;
  readonly files: DiffWalkthroughViewFiles;
  /** Null where the diff keeps no viewed state; sections then step without being marked. */
  readonly viewed: DiffWalkthroughViewedFiles | null;
  /** The diff's identity. The reader's section and folds start over when it changes. */
  readonly resetKey: string;
  /** Starts an agent on a walkthrough. Absent where this client cannot. */
  readonly onGenerate?: (() => void) | undefined;
  /** A generate press is still opening its thread. */
  readonly generatePending?: boolean;
  /** What an empty walkthrough would say about this diff. */
  readonly emptyDescription?: string;
  /** Loads whole files so the reader can expand context around a hunk. */
  readonly loadDiffFiles?: FileDiffContentsLoader | undefined;
  /** For links in note bodies. */
  readonly cwd: string | undefined;
  readonly environmentId: EnvironmentId | undefined;
  readonly handleRef?: Ref<DiffWalkthroughViewHandle>;
  /** The diff's scrolling element, for a host that reacts to the reader scrolling. */
  readonly scrollerRef?: ((node: HTMLDivElement | null) => void) | undefined;
}

const NO_FOLDS: ReadonlySet<string> = new Set();

/**
 * An agent's guide to a diff, one section at a time: a group of whole files with the intent
 * behind them, its notes as links into the files, and the files themselves. Unviewed files are
 * open and viewed ones folded; the reader marks a section reviewed and moves on.
 */
export function DiffWalkthroughView(props: DiffWalkthroughViewProps) {
  const { source, files, onGenerate, generatePending = false } = props;
  if (source.kind === "loading") {
    return <p className="px-4 py-5 text-sm text-muted-foreground">Loading walkthrough...</p>;
  }
  if (source.kind === "error") {
    return <p className="px-4 py-5 text-sm text-muted-foreground">{source.message}</p>;
  }
  if (source.kind === "empty") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No walkthrough yet</EmptyTitle>
          <EmptyDescription>
            {props.emptyDescription ??
              "An agent can group these changes by intent, in the order to read them, and say what each one is for."}
          </EmptyDescription>
        </EmptyHeader>
        {onGenerate === undefined ? null : (
          <EmptyContent>
            <Button type="button" size="sm" disabled={generatePending} onClick={onGenerate}>
              {generatePending ? "Opening..." : "Generate walkthrough"}
            </Button>
          </EmptyContent>
        )}
      </Empty>
    );
  }
  if (files.kind === "loading") return <DiffPanelLoadingState label={files.label} />;
  if (files.kind === "error") {
    return (
      <div className="flex flex-col items-start gap-2 px-4 py-5 text-sm text-muted-foreground">
        <p>{files.message}</p>
        {files.onRetry === undefined ? null : (
          <Button type="button" size="xs" variant="outline" onClick={files.onRetry}>
            Retry
          </Button>
        )}
      </div>
    );
  }
  return (
    <WalkthroughSections
      {...props}
      walkthrough={source.walkthrough}
      staleNotice={source.staleNotice}
      diffFiles={files.files}
    />
  );
}

function WalkthroughSections({
  walkthrough,
  staleNotice,
  diffFiles,
  viewed,
  resetKey,
  onGenerate,
  generatePending = false,
  loadDiffFiles,
  cwd,
  environmentId,
  handleRef,
  scrollerRef,
}: DiffWalkthroughViewProps & {
  readonly walkthrough: DiffWalkthrough;
  readonly staleNotice: string | null;
  readonly diffFiles: ReadonlyArray<DiffWalkthroughViewFile>;
}) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const fileByPath = useMemo(
    () => new Map(diffFiles.map((file) => [file.path, file] as const)),
    [diffFiles],
  );
  const { summary, sections } = useMemo(
    () => buildDiffWalkthroughSections(walkthrough, [...fileByPath.keys()]),
    [fileByPath, walkthrough],
  );

  // Held with the diff they belong to, so a new diff starts on its first section with no file
  // folded against its viewed state, without an effect to reset them.
  const [position, setPosition] = useState({ key: resetKey, index: 0 });
  const [folds, setFolds] = useState({ key: resetKey, toggled: NO_FOLDS });
  const index = clampDiffWalkthroughSectionIndex(
    position.key === resetKey ? position.index : 0,
    sections.length,
  );
  const toggled = folds.key === resetKey ? folds.toggled : NO_FOLDS;
  const section = sections[index];
  const isViewed = useCallback((path: string) => viewed?.isViewed(path) ?? false, [viewed]);

  const goTo = useCallback(
    (next: number) => setPosition({ key: resetKey, index: next }),
    [resetKey],
  );
  // A file the reader folded or opened by hand follows its viewed state again once it changes.
  const setFold = useCallback(
    (paths: ReadonlyArray<string>, change: "toggle" | "follow-viewed") =>
      setFolds((current) => {
        const next = new Set(current.key === resetKey ? current.toggled : NO_FOLDS);
        for (const path of paths) {
          if (change === "follow-viewed" || next.has(path)) next.delete(path);
          else next.add(path);
        }
        return { key: resetKey, toggled: next };
      }),
    [resetKey],
  );
  const toggleFold = useCallback((path: string) => setFold([path], "toggle"), [setFold]);
  const setFileViewed = useCallback(
    (path: string, next: boolean) => {
      viewed?.setViewed(path, next);
      setFold([path], "follow-viewed");
    },
    [setFold, viewed],
  );

  const sectionReviewed =
    section !== undefined && viewed !== null && isDiffWalkthroughSectionReviewed(section, isViewed);
  const isLast = index === sections.length - 1;
  const previous = useCallback(() => goTo(index - 1), [goTo, index]);
  const next = useCallback(() => goTo(index + 1), [goTo, index]);
  const markReviewedAndContinue = useCallback(() => {
    if (section === undefined) return;
    if (viewed !== null) {
      const paths = unviewedSectionFiles(section, isViewed);
      for (const path of paths) viewed.setViewed(path, true);
      setFold(paths, "follow-viewed");
    }
    goTo(sectionIndexAfterReview(index, sections.length));
  }, [goTo, index, isViewed, section, sections.length, setFold, viewed]);
  useImperativeHandle(handleRef, () => ({ previous, next, markReviewedAndContinue }), [
    markReviewedAndContinue,
    next,
    previous,
  ]);

  if (section === undefined) {
    return <p className="px-4 py-5 text-sm text-muted-foreground">This diff has no changes.</p>;
  }

  const reviewLabel = sectionReviewed
    ? isLast
      ? "Reviewed"
      : "Continue"
    : isLast
      ? "Mark reviewed"
      : "Mark reviewed and continue";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Previous section"
          disabled={index === 0}
          onClick={previous}
        >
          <ChevronLeftIcon />
        </Button>
        <ol
          aria-label="Sections"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {sections.map((entry, entryIndex) => (
            <SectionStep
              key={entry.id}
              section={entry}
              index={entryIndex}
              current={entryIndex === index}
              reviewed={viewed !== null && isDiffWalkthroughSectionReviewed(entry, isViewed)}
              onSelect={goTo}
            />
          ))}
        </ol>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Next section"
          disabled={isLast}
          onClick={next}
        >
          <ChevronRightIcon />
        </Button>
        {viewed === null ? null : (
          <Button
            type="button"
            size="xs"
            variant={sectionReviewed ? "outline" : "default"}
            disabled={sectionReviewed && isLast}
            onClick={markReviewedAndContinue}
          >
            {sectionReviewed && isLast ? <CheckIcon /> : null}
            {reviewLabel}
          </Button>
        )}
      </div>
      {staleNotice === null ? null : (
        <div className="shrink-0 border-b border-border/60 p-2">
          <Alert variant="warning" controlAlignment="first-line">
            <HistoryIcon />
            <AlertTitle>{staleNotice}</AlertTitle>
            <AlertDescription>
              Its notes may point at lines that have changed since.
            </AlertDescription>
            {onGenerate === undefined ? null : (
              <AlertAction>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={generatePending}
                  onClick={onGenerate}
                >
                  {generatePending ? "Opening..." : "Regenerate"}
                </Button>
              </AlertAction>
            )}
          </Alert>
        </div>
      )}
      <div className="@container flex min-h-0 flex-1 flex-col">
        {/* Keyed by section, so each one opens at its top in both columns. */}
        <SectionBody
          key={`${resetKey}:${section.id}`}
          section={section}
          ordinal={formatDiffWalkthroughOrdinal(index, sections.length)}
          summary={index === 0 ? summary : null}
          fileByPath={fileByPath}
          viewed={viewed}
          toggled={toggled}
          onToggleFold={toggleFold}
          onSetFileViewed={setFileViewed}
          done={
            isLast && sectionReviewed
              ? { firstUnreviewed: firstUnreviewedSectionIndex(sections, isViewed) }
              : null
          }
          onGoToSection={goTo}
          resolvedTheme={resolvedTheme}
          diffLayout={settings.diffLayout}
          wordWrap={settings.wordWrap}
          loadDiffFiles={loadDiffFiles}
          cwd={cwd}
          environmentId={environmentId}
          scrollerRef={scrollerRef}
        />
      </div>
    </div>
  );
}

const SectionStep = memo(function SectionStep({
  section,
  index,
  current,
  reviewed,
  onSelect,
}: {
  readonly section: DiffWalkthroughSection;
  readonly index: number;
  readonly current: boolean;
  readonly reviewed: boolean;
  readonly onSelect: (index: number) => void;
}) {
  return (
    <li className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-current={current ? "step" : undefined}
              aria-label={`${section.title}${reviewed ? ", reviewed" : ""}`}
              className={cn(
                "flex size-5 items-center justify-center rounded-full text-3xs font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                current
                  ? "bg-primary text-primary-foreground"
                  : reviewed
                    ? "bg-success/12 text-success hover:bg-success/20"
                    : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
              onClick={() => onSelect(index)}
            />
          }
        >
          {reviewed && !current ? <CheckIcon aria-hidden className="size-3" /> : index + 1}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{section.title}</TooltipPopup>
      </Tooltip>
    </li>
  );
});

function SectionBody({
  section,
  ordinal,
  summary,
  fileByPath,
  viewed,
  toggled,
  onToggleFold,
  onSetFileViewed,
  done,
  onGoToSection,
  resolvedTheme,
  diffLayout,
  wordWrap,
  loadDiffFiles,
  cwd,
  environmentId,
  scrollerRef,
}: {
  readonly section: DiffWalkthroughSection;
  readonly ordinal: string;
  /** The walkthrough's own summary, shown over its first section. */
  readonly summary: string | null;
  readonly fileByPath: ReadonlyMap<string, DiffWalkthroughViewFile>;
  readonly viewed: DiffWalkthroughViewedFiles | null;
  /** Files the reader folded or opened against their viewed state. */
  readonly toggled: ReadonlySet<string>;
  readonly onToggleFold: (path: string) => void;
  readonly onSetFileViewed: (path: string, viewed: boolean) => void;
  /** Set on the last section once it is reviewed. */
  readonly done: { readonly firstUnreviewed: number | null } | null;
  readonly onGoToSection: (index: number) => void;
  readonly resolvedTheme: "light" | "dark";
  readonly diffLayout: "stacked" | "split";
  readonly wordWrap: boolean;
  readonly loadDiffFiles: FileDiffContentsLoader | undefined;
  readonly cwd: string | undefined;
  readonly environmentId: EnvironmentId | undefined;
  readonly scrollerRef: ((node: HTMLDivElement | null) => void) | undefined;
}) {
  const [viewer, setViewer] = useState<CodeViewHandle<undefined, undefined> | null>(null);
  const sectionFiles = useMemo(
    () =>
      section.files.flatMap((path) => {
        const file = fileByPath.get(path);
        return file === undefined ? [] : [file];
      }),
    [fileByPath, section.files],
  );
  const isCollapsed = useCallback(
    (path: string) => (viewed?.isViewed(path) ?? false) !== toggled.has(path),
    [toggled, viewed],
  );
  const items = useMemo<CodeViewDiffItem<undefined>[]>(
    () =>
      sectionFiles.map((file) => {
        const collapsed = isCollapsed(file.path);
        const viewedMark =
          viewed === null
            ? ""
            : `${viewed.isViewed(file.path) ? "v" : ""}${viewed.isStale?.(file.path) ? "s" : ""}`;
        return {
          id: file.key,
          type: "diff" as const,
          fileDiff: file.fileDiff,
          collapsed,
          version: fnv1a32(`${collapsed ? "1" : "0"}:${viewedMark}`),
        };
      }),
    [isCollapsed, sectionFiles, viewed],
  );
  const expandedFileKeys = useMemo(
    () => items.filter((item) => item.collapsed !== true).map((item) => item.id),
    [items],
  );
  const requestReveal = useCodeViewFileReveal(viewer, section.id, expandedFileKeys);
  const revealNote = useCallback(
    (note: DiffWalkthroughNote) => {
      const file = fileByPath.get(note.path);
      if (file === undefined) return;
      if (isCollapsed(note.path)) onToggleFold(note.path);
      requestReveal(file.key, {
        start: note.startLine,
        end: note.endLine,
        side: note.side,
        endSide: note.side,
      });
    },
    [fileByPath, isCollapsed, onToggleFold, requestReveal],
  );

  // Read through refs rather than closed over: the viewer memoizes each visible file's header
  // portal on these callbacks, so a fresh identity per tick would rebuild every header.
  const viewedRef = useRef(viewed);
  viewedRef.current = viewed;
  const onSetFileViewedRef = useRef(onSetFileViewed);
  onSetFileViewedRef.current = onSetFileViewed;
  const onToggleFoldRef = useRef(onToggleFold);
  onToggleFoldRef.current = onToggleFold;
  const fileByKey = useMemo(
    () => new Map(sectionFiles.map((file) => [file.key, file] as const)),
    [sectionFiles],
  );
  const renderHeaderPrefix = useCallback(
    (item: CodeViewItem<undefined>) => {
      const file = fileByKey.get(item.id);
      return file === undefined ? null : (
        <DiffFileFoldButton
          collapsed={item.collapsed === true}
          onToggle={() => onToggleFoldRef.current(file.path)}
        />
      );
    },
    [fileByKey],
  );
  const renderHeaderMetadata = useCallback(
    (item: CodeViewItem<undefined>) => {
      const file = fileByKey.get(item.id);
      if (file === undefined) return null;
      const viewedFiles = viewedRef.current;
      return (
        <DiffFileHeaderMetadata
          additions={file.additions}
          deletions={file.deletions}
          {...(viewedFiles === null
            ? {}
            : {
                viewed: {
                  viewed: viewedFiles.isViewed(file.path),
                  stale: viewedFiles.isStale?.(file.path) ?? false,
                  onViewedChange: (next: boolean) => onSetFileViewedRef.current(file.path, next),
                },
              })}
        />
      );
    },
    [fileByKey],
  );
  const options = useMemo(
    () => ({
      diffStyle: diffLayout === "split" ? ("split" as const) : ("unified" as const),
      lineDiffType: "none" as const,
      overflow: wordWrap ? ("wrap" as const) : ("scroll" as const),
      theme: resolveDiffThemeName(resolvedTheme),
      preferredHighlighter: PREFERRED_HIGHLIGHTER,
      themeType: resolvedTheme,
      stickyHeaders: true,
      ...(loadDiffFiles === undefined ? {} : { loadDiffFiles }),
    }),
    [diffLayout, loadDiffFiles, resolvedTheme, wordWrap],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col @2xl:flex-row">
      <div className="max-h-[40%] shrink-0 overflow-y-auto border-b border-border/60 px-4 py-3 @2xl:max-h-none @2xl:w-80 @2xl:border-r @2xl:border-b-0">
        {summary === null ? null : (
          <p className="mb-4 text-xs leading-5 text-muted-foreground">{summary}</p>
        )}
        <p className="font-mono text-2xs tabular-nums text-muted-foreground">{ordinal}</p>
        <h2 className="mt-1 text-sm font-medium text-foreground">{section.title}</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{section.summary}</p>
        {section.notes.length === 0 ? null : (
          <ul className="mt-3 space-y-0.5">
            {section.notes.map((entry) => (
              <SectionNote
                key={entry.key}
                entry={entry}
                onReveal={revealNote}
                cwd={cwd}
                environmentId={environmentId}
              />
            ))}
          </ul>
        )}
        {done === null ? null : (
          <div className="mt-4">
            {done.firstUnreviewed === null ? (
              <Alert variant="success">
                <CircleCheckIcon />
                <AlertTitle>Walkthrough reviewed</AlertTitle>
                <AlertDescription>Every file in every section is marked viewed.</AlertDescription>
              </Alert>
            ) : (
              <Alert variant="info" controlAlignment="first-line">
                <CircleCheckIcon />
                <AlertTitle>Last section reviewed</AlertTitle>
                <AlertDescription>An earlier section still has files to view.</AlertDescription>
                <AlertAction>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => onGoToSection(done.firstUnreviewed ?? 0)}
                  >
                    Go to section {done.firstUnreviewed + 1}
                  </Button>
                </AlertAction>
              </Alert>
            )}
          </div>
        )}
      </div>
      <div
        className="relative min-h-0 min-w-0 flex-1"
        onClickCapture={(event) => {
          const path = pressedDiffHeaderPath(event);
          if (path !== null && fileByPath.has(path)) onToggleFold(path);
        }}
      >
        {/* The viewer virtualizes against the element it scrolls, so it owns that element. */}
        <StyledDiffCodeView<undefined>
          className="@container h-full overflow-auto [scrollbar-gutter:stable]"
          {...(scrollerRef === undefined ? {} : { containerRef: scrollerRef })}
          viewerRef={setViewer}
          items={items}
          options={options}
          renderHeaderPrefix={renderHeaderPrefix}
          renderHeaderMetadata={renderHeaderMetadata}
          // Find can ask again before the unfolded file arrives, so this unfolds and never folds.
          onRevealSearchMatch={(item) => {
            const file = fileByKey.get(item.id);
            if (file !== undefined && isCollapsed(file.path)) onToggleFold(file.path);
          }}
          unsafeCSSExtra={REPLACE_FILE_COUNTS_CSS}
        />
      </div>
    </div>
  );
}

function SectionNote({
  entry,
  onReveal,
  cwd,
  environmentId,
}: {
  readonly entry: DiffWalkthroughSectionNote;
  readonly onReveal: (note: DiffWalkthroughNote) => void;
  readonly cwd: string | undefined;
  readonly environmentId: EnvironmentId | undefined;
}) {
  const { note } = entry;
  const row = (
    <button
      type="button"
      className="flex min-w-0 flex-1 flex-col items-start gap-0.5 py-1 text-left"
      onClick={() => onReveal(note)}
    >
      <span className="text-xs text-foreground">{note.summary}</span>
      <span className="max-w-full truncate font-mono text-3xs text-muted-foreground">
        {formatDiffWalkthroughNoteRange(note)}
      </span>
    </button>
  );
  const rowClassName =
    "flex items-start gap-1 rounded-sm border-l-2 border-border/60 pr-1 pl-2 hover:border-primary hover:bg-accent/60";
  if (note.body === undefined) return <li className={rowClassName}>{row}</li>;
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
          <div className="ml-0.5 border-l-2 border-border/60 py-1 pr-2 pl-3 text-xs">
            <ChatMarkdown text={note.body} cwd={cwd} environmentId={environmentId} />
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </li>
  );
}
