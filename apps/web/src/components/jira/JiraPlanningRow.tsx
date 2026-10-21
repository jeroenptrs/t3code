import type { JiraIssueSummary } from "@t3tools/contracts";
import { memo, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowLines,
} from "../pullRequest/PullRequestListRow";
import { PullRequestActorAvatar } from "../pullRequest/pullRequestPresentation";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { formatJiraPoints, parseJiraStoryPointsInput } from "./jiraPlanning.logic";
import { JiraStatusBadge } from "./jiraPresentation";

/**
 * Story points edited in place: Enter or leaving the field saves, an emptied field clears the
 * estimate, Escape puts the old value back. A saved value stays shown until the row's value moves
 * off the estimate it replaced, so the field never flashes back to the old estimate.
 */
function JiraStoryPointsField({
  issueKey,
  value,
  onCommit,
}: {
  issueKey: string;
  value: number | null;
  /** Resolves true once Jira has the new estimate. */
  onCommit: (storyPoints: number | null) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{
    readonly over: number | null;
    readonly value: number | null;
  }>();
  // Enter disables the field, which blurs it within the same render; this guard is synchronous.
  const inFlight = useRef(false);
  // Once the row carries anything but the estimate the save replaced, the saved value or someone
  // else's, the row is shown again; a later return to the replaced estimate must not revive it.
  if (saved !== undefined && saved.over !== value) setSaved(undefined);
  const current = saved !== undefined && saved.over === value ? saved.value : value;
  const shown = current === null ? "" : formatJiraPoints(current);
  const text = draft ?? shown;

  const commit = async () => {
    if (draft === null || inFlight.current) return;
    const parsed = parseJiraStoryPointsInput(draft);
    if (!parsed.ok) {
      setInvalid(parsed.message);
      return;
    }
    // Compared as shown, so retyping a rounded estimate does not overwrite its exact value.
    if ((parsed.storyPoints === null ? "" : formatJiraPoints(parsed.storyPoints)) === shown) {
      setDraft(null);
      return;
    }
    inFlight.current = true;
    setSaving(true);
    const ok = await onCommit(parsed.storyPoints);
    inFlight.current = false;
    setSaving(false);
    setDraft(null);
    if (ok) setSaved({ over: value, value: parsed.storyPoints });
  };

  return (
    <div className="w-16 shrink-0">
      <Input
        size="compact"
        inputMode="decimal"
        aria-label={`Story points for ${issueKey}`}
        placeholder="–"
        title={invalid ?? "Story points"}
        aria-invalid={invalid !== null ? true : undefined}
        disabled={saving}
        value={text}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setInvalid(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          } else if (event.key === "Escape") {
            // Escape here cancels the edit; it must not also leave the page or close the panel.
            event.preventDefault();
            event.stopPropagation();
            setDraft(null);
            setInvalid(null);
          }
        }}
        onBlur={() => {
          if (draft !== null && !parseJiraStoryPointsInput(draft).ok) {
            setDraft(null);
            setInvalid(null);
            return;
          }
          void commit();
        }}
      />
    </div>
  );
}

function JiraPlanningRowImpl({
  sectionId,
  issue,
  opened,
  selected,
  writable,
  onOpen,
  onToggleSelected,
  onCommitStoryPoints,
}: {
  /** The section listing this row, which a move re-reads. */
  sectionId: string;
  issue: JiraIssueSummary;
  /** Open in the right panel. */
  opened: boolean;
  selected: boolean;
  /** The user can move and estimate issues as themselves. */
  writable: boolean;
  onOpen: (issue: JiraIssueSummary) => void;
  onToggleSelected: (sectionId: string, issueKey: string, selected: boolean) => void;
  onCommitStoryPoints: (issue: JiraIssueSummary, storyPoints: number | null) => Promise<boolean>;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md pr-2 [content-visibility:auto] [contain-intrinsic-block-size:56.5px]",
        writable && "pl-3",
        opened ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      {writable ? (
        <Checkbox
          aria-label={`Select ${issue.key}`}
          checked={selected}
          onCheckedChange={(checked) => onToggleSelected(sectionId, issue.key, checked)}
        />
      ) : null}
      <button
        type="button"
        aria-current={opened ? "true" : undefined}
        onClick={() => onOpen(issue)}
        className={cn(
          PULL_REQUEST_ROW_CLASS,
          "min-w-0 flex-1 cursor-pointer py-2.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          writable ? "pr-3" : "px-3",
        )}
      >
        <PullRequestRowLines
          number={<span className={PULL_REQUEST_ROW_NUMBER_CLASS}>{issue.key}</span>}
          title={issue.summary}
          status={
            writable || issue.storyPoints === null ? null : (
              <span className="tabular-nums text-muted-foreground">
                {formatJiraPoints(issue.storyPoints)} pt
                <span className="sr-only"> story points</span>
              </span>
            )
          }
          meta={
            <>
              <JiraStatusBadge category={issue.statusCategory} status={issue.status} size="sm" />
              {issue.issueType ? <span className="shrink-0">{issue.issueType}</span> : null}
              {issue.priority ? <span className="shrink-0">{issue.priority}</span> : null}
              <span className="inline-flex min-w-0 max-w-40 items-center gap-1">
                <PullRequestActorAvatar
                  actor={
                    issue.assignee === null
                      ? null
                      : {
                          login: issue.assignee.displayName || "?",
                          name: issue.assignee.displayName,
                          avatarUrl: issue.assignee.avatarUrl,
                        }
                  }
                  className="size-3.5"
                />
                <span className="truncate">{issue.assignee?.displayName ?? "Unassigned"}</span>
              </span>
            </>
          }
          updatedAt={issue.updated}
        />
      </button>
      {writable ? (
        <JiraStoryPointsField
          issueKey={issue.key}
          value={issue.storyPoints}
          onCommit={(storyPoints) => onCommitStoryPoints(issue, storyPoints)}
        />
      ) : null}
    </div>
  );
}

/** Memoized: selection and paging re-render a section, rarely a given row. */
export const JiraPlanningRow = memo(JiraPlanningRowImpl);
