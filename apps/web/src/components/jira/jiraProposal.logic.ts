import { jiraIssueUrl } from "@t3tools/client-runtime/state/jira";
import {
  JIRA_ISSUE_KEY_PATTERN,
  type JiraCreateMeta,
  type JiraIssueDraft,
  type JiraProposal,
  type JiraProposalDecisionInput,
  type JiraProposalResult,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";

export type JiraProposalItem = Extract<OrchestrationV2TurnItem, { readonly type: "jira_proposal" }>;
type JiraProposalIssue = JiraProposalResult["issues"][number];

const SUMMARY_MAX = 255;
const ISSUE_TYPE_MAX = 100;
const MARKDOWN_MAX = 32_000;

/** What the card shows: an editable form, a one-line outcome, or a pending item it cannot decide. */
export type JiraProposalDisplay =
  | { readonly kind: "editable" }
  | { readonly kind: "writing" }
  | { readonly kind: "pending-elsewhere" }
  | { readonly kind: "applied" }
  | { readonly kind: "rejected" }
  | { readonly kind: "failed-elsewhere" };

/**
 * `visibility` is the projected row's: a proposal inherited from another thread (a fork) is decided
 * where it was proposed, so it only shows its state here.
 */
export function jiraProposalDisplay(
  item: Pick<JiraProposalItem, "proposalStatus">,
  visibility: OrchestrationV2ProjectedTurnItem["visibility"],
): JiraProposalDisplay {
  const local = visibility === "local";
  switch (item.proposalStatus) {
    case "pending":
      return local ? { kind: "editable" } : { kind: "pending-elsewhere" };
    case "failed":
      return local ? { kind: "editable" } : { kind: "failed-elsewhere" };
    case "approved":
      return { kind: "writing" };
    case "applied":
      return { kind: "applied" };
    case "rejected":
      return { kind: "rejected" };
  }
}

/** One line naming what the proposal asks for, before it is decided. */
export function jiraProposalTitle(proposal: JiraProposal): string {
  switch (proposal.kind) {
    case "create-issues": {
      const count = proposal.issues.length;
      const projects = [...new Set(proposal.issues.map((draft) => draft.projectKey))];
      const where = projects.length === 1 ? ` in ${projects[0]}` : "";
      return `Create ${count === 1 ? "1 Jira issue" : `${count} Jira issues`}${where}`;
    }
    case "comment":
      return `Comment on ${proposal.key}`;
    case "transition":
      return `Move ${proposal.key} to ${proposal.transitionName}`;
  }
}

/**
 * What an applied proposal did, as a verb, the issues it touched and an optional tail, so the card
 * can render each key as a link. Created issues come in draft order.
 */
export function jiraProposalOutcome(
  proposal: JiraProposal,
  result: JiraProposalResult | undefined,
): {
  readonly verb: string;
  readonly issues: ReadonlyArray<JiraProposalIssue>;
  readonly tail: string | null;
} {
  const issues = jiraProposalIssues(result);
  switch (proposal.kind) {
    case "create-issues":
      return { verb: "Created", issues, tail: null };
    case "comment":
      return { verb: "Commented on", issues: fallbackIssue(issues, proposal), tail: null };
    case "transition":
      return {
        verb: "Moved",
        issues: fallbackIssue(issues, proposal),
        tail: `to ${proposal.transitionName}`,
      };
  }
}

function fallbackIssue(
  issues: ReadonlyArray<JiraProposalIssue>,
  proposal: { readonly site: string; readonly key: string },
): ReadonlyArray<JiraProposalIssue> {
  if (issues.length > 0) return issues;
  return [{ site: proposal.site, key: proposal.key, url: jiraIssueUrl(proposal) }];
}

/** What a result wrote, created issues in draft order. */
export function jiraProposalIssues(
  result: JiraProposalResult | undefined,
): ReadonlyArray<JiraProposalIssue> {
  return (result?.issues ?? []).toSorted(
    (left, right) => (left.draftIndex ?? 0) - (right.draftIndex ?? 0),
  );
}

/** The issue already created from a draft, when an earlier approval got that far. */
export function createdIssueForDraft(
  result: JiraProposalResult | undefined,
  draftIndex: number,
): JiraProposalIssue | null {
  return result?.issues.find((issue) => issue.draftIndex === draftIndex) ?? null;
}

/** The editable fields of one draft, as the form holds them. */
export interface JiraDraftEdit {
  /** The draft's position in the proposal, which a retry must keep. */
  readonly draftIndex: number;
  readonly summary: string;
  readonly issueType: string;
  readonly storyPoints: string;
  readonly sprintId: number | null;
  readonly parentKey: string;
}

export type JiraProposalEdits =
  | { readonly kind: "create-issues"; readonly drafts: ReadonlyArray<JiraDraftEdit> }
  | { readonly kind: "comment"; readonly body: string }
  | { readonly kind: "transition"; readonly comment: string };

export function initialJiraProposalEdits(proposal: JiraProposal): JiraProposalEdits {
  switch (proposal.kind) {
    case "create-issues":
      return {
        kind: "create-issues",
        drafts: proposal.issues.map((draft, draftIndex) => ({
          draftIndex,
          summary: draft.summary,
          issueType: draft.issueType,
          storyPoints: draft.storyPoints === null ? "" : String(draft.storyPoints),
          sprintId: draft.sprintId,
          parentKey: draft.parentKey ?? "",
        })),
      };
    case "comment":
      return { kind: "comment", body: proposal.body };
    case "transition":
      return { kind: "transition", comment: proposal.comment ?? "" };
  }
}

export type JiraDraftField = "summary" | "issueType" | "storyPoints" | "parentKey";

/** Why each field of a draft cannot be approved as typed; empty when it can. */
export function jiraDraftEditErrors(edit: JiraDraftEdit): Partial<Record<JiraDraftField, string>> {
  const errors: Partial<Record<JiraDraftField, string>> = {};
  const summary = edit.summary.trim();
  if (summary.length === 0) errors.summary = "Add a summary";
  else if (summary.length > SUMMARY_MAX) errors.summary = `At most ${SUMMARY_MAX} characters`;
  const issueType = edit.issueType.trim();
  if (issueType.length === 0) errors.issueType = "Pick an issue type";
  else if (issueType.length > ISSUE_TYPE_MAX) errors.issueType = "Too long";
  if (parseStoryPoints(edit.storyPoints) === undefined) errors.storyPoints = "Use a number from 0";
  if (parseParentKey(edit.parentKey) === undefined) errors.parentKey = "Use a key like ABC-12";
  return errors;
}

/** Null for blank, undefined when invalid. */
function parseStoryPoints(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Null for blank, undefined when it is not an issue key. */
function parseParentKey(text: string): string | null | undefined {
  const key = text.trim().toUpperCase();
  if (key.length === 0) return null;
  return JIRA_ISSUE_KEY_PATTERN.test(key) ? key : undefined;
}

function applyDraftEdit(draft: JiraIssueDraft, edit: JiraDraftEdit): JiraIssueDraft | null {
  if (Object.keys(jiraDraftEditErrors(edit)).length > 0) return null;
  return {
    ...draft,
    summary: edit.summary.trim(),
    issueType: edit.issueType.trim(),
    storyPoints: parseStoryPoints(edit.storyPoints) ?? null,
    sprintId: edit.sprintId,
    parentKey: parseParentKey(edit.parentKey) ?? null,
  };
}

/**
 * The proposal to approve with the user's edits, or null while something cannot be approved.
 * Drafts an earlier approval already created go back unchanged, since the server skips them by
 * position.
 */
export function approvedJiraProposal(
  proposal: JiraProposal,
  edits: JiraProposalEdits,
  result?: JiraProposalResult,
): JiraProposal | null {
  if (proposal.kind === "create-issues" && edits.kind === "create-issues") {
    if (edits.drafts.length === 0) return null;
    const issues: JiraIssueDraft[] = [];
    for (const edit of edits.drafts) {
      const draft = proposal.issues[edit.draftIndex];
      if (draft === undefined) return null;
      if (createdIssueForDraft(result, edit.draftIndex) !== null) {
        issues.push(draft);
        continue;
      }
      const edited = applyDraftEdit(draft, edit);
      if (edited === null) return null;
      issues.push(edited);
    }
    return { ...proposal, issues };
  }
  if (proposal.kind === "comment" && edits.kind === "comment") {
    const body = edits.body.trim();
    if (body.length === 0 || body.length > MARKDOWN_MAX) return null;
    return { ...proposal, body };
  }
  if (proposal.kind === "transition" && edits.kind === "transition") {
    const comment = edits.comment.trim();
    if (comment.length > MARKDOWN_MAX) return null;
    return { ...proposal, comment: comment.length === 0 ? null : comment };
  }
  return null;
}

export function jiraProposalDecisionInput(
  item: Pick<JiraProposalItem, "id" | "threadId">,
  decision: JiraProposalDecisionInput["decision"],
): JiraProposalDecisionInput {
  return { threadId: item.threadId, proposalId: item.id, decision };
}

/** What the approve button says for the proposal as edited. */
export function jiraProposalApproveLabel(
  proposal: JiraProposal,
  edits: JiraProposalEdits,
  retry: boolean,
): string {
  if (retry) return "Retry";
  switch (proposal.kind) {
    case "create-issues": {
      const count = edits.kind === "create-issues" ? edits.drafts.length : proposal.issues.length;
      return count === 1 ? "Create 1 issue" : `Create ${count} issues`;
    }
    case "comment":
      return "Post comment";
    case "transition":
      return `Move to ${proposal.transitionName}`;
  }
}

export interface JiraSelectOption<Value> {
  readonly value: Value;
  readonly label: string;
}

/** The project's issue types, keeping the draft's own type pickable when the project lacks it. */
export function jiraIssueTypeOptions(
  meta: JiraCreateMeta | null,
  current: string,
): ReadonlyArray<JiraSelectOption<string>> {
  const options = (meta?.issueTypes ?? []).map((type) => ({ value: type.name, label: type.name }));
  const trimmed = current.trim();
  if (trimmed.length > 0 && !options.some((option) => option.value === trimmed)) {
    options.unshift({ value: trimmed, label: trimmed });
  }
  return options;
}

export const NO_SPRINT_OPTION = "none";

/**
 * "No sprint", then the project's sprints, keeping an unknown current sprint pickable by id.
 * Values are strings, since a select treats null as nothing chosen.
 */
export function jiraSprintOptions(
  meta: JiraCreateMeta | null,
  current: number | null,
): ReadonlyArray<JiraSelectOption<string>> {
  const sprints = (meta?.sprints ?? []).map((sprint) => ({
    value: String(sprint.id),
    label: sprint.name,
  }));
  if (current !== null && !sprints.some((option) => option.value === String(current))) {
    sprints.unshift({ value: String(current), label: `Sprint ${current}` });
  }
  return [{ value: NO_SPRINT_OPTION, label: "No sprint" }, ...sprints];
}

export function jiraSprintOptionValue(sprintId: number | null): string {
  return sprintId === null ? NO_SPRINT_OPTION : String(sprintId);
}

export function jiraSprintIdFromOption(value: string): number | null {
  const id = Number(value);
  return value !== NO_SPRINT_OPTION && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Failures whose message is written for the user. */
const USER_FACING_FAILURE_TAGS = new Set(["JiraError", "EnvironmentAuthorizationError"]);

/** Inline copy for a decision the server refused; transport failures get generic copy. */
export function jiraProposalFailureMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    USER_FACING_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return "Could not reach the server. Try again.";
}
