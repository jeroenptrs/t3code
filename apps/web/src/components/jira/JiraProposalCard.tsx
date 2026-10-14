import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { jiraIssueUrl } from "@t3tools/client-runtime/state/jira";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AuthUserId,
  EnvironmentId,
  JiraCapabilities,
  JiraIssueDraft,
  JiraIssueKey,
  JiraProposalDecisionInput,
  OrchestrationV2ProjectedTurnItem,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { CheckIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Fragment, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { usePrimarySessionState } from "~/environments/primary";
import { useRightPanelStore } from "~/rightPanelStore";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { jiraEnvironment, jiraFailureReason, useJiraCapabilities } from "~/state/jira";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import ChatMarkdown from "../ChatMarkdown";
import { JiraIcon } from "../Icons";
import { WorkLogRow } from "../chat/WorkLog";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { personalCredentialForSite } from "./jiraIssueList.logic";
import {
  approvedJiraProposal,
  createdIssueForDraft,
  initialJiraProposalEdits,
  jiraDraftEditErrors,
  jiraIssueTypeOptions,
  jiraProposalApproveLabel,
  jiraProposalDecisionInput,
  jiraProposalDisplay,
  jiraProposalFailureMessage,
  jiraProposalIssues,
  jiraProposalOutcome,
  jiraProposalTitle,
  jiraSprintIdFromOption,
  jiraSprintOptions,
  jiraSprintOptionValue,
  type JiraDraftEdit,
  type JiraProposalEdits,
  type JiraProposalItem,
} from "./jiraProposal.logic";

const ROW_STATUS_LABEL = {
  writing: "Writing to Jira…",
  "pending-elsewhere": "Waiting for approval in the original thread",
  "failed-elsewhere": "Failed in the original thread",
  rejected: "Rejected",
} as const;

/**
 * A Jira write an agent proposed. While it waits, the user can edit it and approve it, which
 * writes to Jira with their own token, or reject it. Decided proposals collapse to one line.
 */
export function JiraProposalCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly item: JiraProposalItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item } = props;
  const threadRef = props.threadRef ?? scopeThreadRef(props.environmentId, item.threadId);
  const display = jiraProposalDisplay(item, props.visibility);
  const icon = <JiraIcon className="size-3.5 text-icon-muted" />;
  if (display.kind === "editable") {
    return (
      <JiraProposalForm
        key={item.id}
        environmentId={props.environmentId}
        threadRef={threadRef}
        item={item}
      />
    );
  }
  if (display.kind === "applied") {
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<CheckIcon className="size-3.5 text-icon-muted" aria-hidden />}
        label={
          <>
            <JiraProposalOutcomeText threadRef={threadRef} item={item} />
            {" · "}
            <ApprovedBy environmentId={props.environmentId} userId={item.decidedByUserId} />
          </>
        }
      />
    );
  }
  return (
    <WorkLogRow
      data-v2-item-type={item.type}
      icon={icon}
      label={`${jiraProposalTitle(item.proposal)} · ${ROW_STATUS_LABEL[display.kind]}`}
    />
  );
}

/** Opens the issue beside the thread; a modified click follows the link to Jira instead. */
function JiraIssueKeyLink(props: {
  readonly threadRef: ScopedThreadRef;
  readonly issue: JiraIssueKey & { readonly url?: string };
}) {
  const { issue } = props;
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    useRightPanelStore
      .getState()
      .openJiraIssue(props.threadRef, { site: issue.site, key: issue.key });
  };
  return (
    <a
      href={issue.url ?? jiraIssueUrl(issue)}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-foreground underline-offset-2 hover:underline"
      onClick={onClick}
    >
      {issue.key}
    </a>
  );
}

function JiraIssueKeyList(props: {
  readonly threadRef: ScopedThreadRef;
  readonly issues: ReadonlyArray<JiraIssueKey & { readonly url?: string }>;
}) {
  return props.issues.map((issue, index) => (
    <Fragment key={`${issue.site}/${issue.key}`}>
      {index > 0 ? ", " : null}
      <JiraIssueKeyLink threadRef={props.threadRef} issue={issue} />
    </Fragment>
  ));
}

function JiraProposalOutcomeText(props: {
  readonly threadRef: ScopedThreadRef;
  readonly item: JiraProposalItem;
  readonly prefix?: string;
}) {
  const outcome = jiraProposalOutcome(props.item.proposal, props.item.result);
  const verb = props.prefix ? `${props.prefix} ${outcome.verb.toLowerCase()}` : outcome.verb;
  return (
    <>
      {verb} <JiraIssueKeyList threadRef={props.threadRef} issues={outcome.issues} />
      {outcome.tail === null ? null : ` ${outcome.tail}`}
    </>
  );
}

/** "Approved by you" only where the client knows who it is signed in as: its primary server. */
function ApprovedBy(props: {
  readonly environmentId: EnvironmentId;
  readonly userId: AuthUserId | undefined;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const session = usePrimarySessionState();
  const isMe =
    props.userId !== undefined &&
    props.environmentId === primaryEnvironmentId &&
    session.data?.user?.userId === props.userId;
  return isMe ? "Approved by you" : "Approved";
}

type Decision = JiraProposalDecisionInput["decision"];

function JiraProposalForm(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly item: JiraProposalItem;
}) {
  const { environmentId, item } = props;
  const proposal = item.proposal;
  const retry = item.proposalStatus === "failed";
  const capabilities = useJiraCapabilities(environmentId);
  const canOperate = useAtomValue(jiraEnvironment.decideProposal.permissionAtom(environmentId));
  const decide = useAtomCommand(jiraEnvironment.decideProposal, {
    label: "decide Jira proposal",
    // The card shows the failure inline.
    reportFailure: false,
  });
  const [edits, setEdits] = useState<JiraProposalEdits>(() => initialJiraProposalEdits(proposal));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; needsToken: boolean } | null>(null);
  // Two clicks can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const approved = approvedJiraProposal(proposal, edits, item.result);
  const hasToken =
    capabilities !== null && personalCredentialForSite(capabilities, proposal.site) !== null;
  const needsToken = (capabilities !== null && !hasToken) || error?.needsToken === true;
  const canApprove =
    canOperate && capabilities?.configured === true && !needsToken && approved !== null;

  const send = async (decision: Decision) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await decide({
      environmentId,
      input: jiraProposalDecisionInput(item, decision),
    }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    // Success, including a write that failed, shows on the item itself once it updates.
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError({
      message: jiraProposalFailureMessage(failure),
      needsToken: jiraFailureReason(failure) === "personal-token-required",
    });
  };

  const setDraft = (draftIndex: number, change: Partial<JiraDraftEdit>) =>
    setEdits((current) =>
      current.kind !== "create-issues"
        ? current
        : {
            ...current,
            drafts: current.drafts.map((draft) =>
              draft.draftIndex === draftIndex ? { ...draft, ...change } : draft,
            ),
          },
    );
  const removeDraft = (draftIndex: number) =>
    setEdits((current) =>
      current.kind !== "create-issues"
        ? current
        : { ...current, drafts: current.drafts.filter((draft) => draft.draftIndex !== draftIndex) },
    );

  const written = jiraProposalIssues(item.result);

  return (
    <div
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
        <JiraIcon className="size-4 shrink-0 text-icon-muted" />
        <span className="min-w-0 truncate">
          <JiraProposalHeading threadRef={props.threadRef} item={item} />
        </span>
      </div>

      {proposal.kind === "create-issues" && edits.kind === "create-issues" ? (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {edits.drafts.map((edit) => {
            const draft = proposal.issues[edit.draftIndex];
            if (draft === undefined) return null;
            const created = createdIssueForDraft(item.result, edit.draftIndex);
            return (
              <li key={edit.draftIndex} className="min-w-0">
                {created !== null ? (
                  <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                    <CheckIcon aria-hidden className="size-3.5 shrink-0" />
                    <JiraIssueKeyLink threadRef={props.threadRef} issue={created} />
                    <span className="min-w-0 truncate">{draft.summary}</span>
                  </p>
                ) : (
                  <JiraDraftEditor
                    environmentId={environmentId}
                    threadRef={props.threadRef}
                    site={proposal.site}
                    draft={draft}
                    edit={edit}
                    readMeta={capabilities?.configured === true}
                    disabled={submitting}
                    // Removing a draft after a partial write would shift the drafts the server
                    // already created, so only an untouched proposal can drop one.
                    removable={!retry && edits.drafts.length > 1}
                    onChange={(change) => setDraft(edit.draftIndex, change)}
                    onRemove={() => removeDraft(edit.draftIndex)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {proposal.kind === "comment" && edits.kind === "comment" ? (
        <Textarea
          size="sm"
          aria-label="Comment"
          value={edits.body}
          disabled={submitting}
          aria-invalid={edits.body.trim().length === 0 || undefined}
          onChange={(event) => setEdits({ kind: "comment", body: event.currentTarget.value })}
        />
      ) : null}

      {proposal.kind === "transition" && edits.kind === "transition" ? (
        <Textarea
          size="sm"
          aria-label="Comment"
          placeholder="Optional comment"
          value={edits.comment}
          disabled={submitting}
          onChange={(event) => setEdits({ kind: "transition", comment: event.currentTarget.value })}
        />
      ) : null}

      {retry ? (
        <div role="alert" className="flex min-w-0 flex-col gap-1 text-xs">
          <p className="text-destructive">{item.error ?? "Writing to Jira failed."}</p>
          {written.length > 0 ? (
            <p className="text-muted-foreground">
              <JiraProposalOutcomeText threadRef={props.threadRef} item={item} prefix="Already" />.
              Retrying writes only the rest.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <div className="min-w-0 flex-1 text-xs">
          <ApprovalNotice
            capabilities={capabilities}
            canOperate={canOperate}
            needsToken={needsToken}
            site={proposal.site}
            error={error !== null && !error.needsToken ? error.message : null}
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={submitting || !canOperate}
          onClick={() => void send({ type: "reject" })}
        >
          Reject
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={submitting || !canApprove}
          onClick={() => {
            if (approved !== null) void send({ type: "approve", proposal: approved });
          }}
        >
          {jiraProposalApproveLabel(proposal, edits, retry)}
        </Button>
      </div>
    </div>
  );
}

function JiraProposalHeading(props: {
  readonly threadRef: ScopedThreadRef;
  readonly item: JiraProposalItem;
}) {
  const { proposal } = props.item;
  switch (proposal.kind) {
    case "create-issues":
      return jiraProposalTitle(proposal);
    case "comment":
      return (
        <>
          Comment on <JiraIssueKeyLink threadRef={props.threadRef} issue={proposal} />
        </>
      );
    case "transition":
      return (
        <>
          Move <JiraIssueKeyLink threadRef={props.threadRef} issue={proposal} /> to{" "}
          {proposal.transitionName}
        </>
      );
  }
}

/** Why Approve is off, or what the server refused; the token case links to where to add one. */
function ApprovalNotice(props: {
  readonly capabilities: JiraCapabilities | null;
  readonly canOperate: boolean;
  readonly needsToken: boolean;
  readonly site: string;
  readonly error: string | null;
}): ReactNode {
  if (props.error !== null) {
    return (
      <p role="alert" className="text-destructive">
        {props.error}
      </p>
    );
  }
  if (!props.canOperate) {
    return <p className="text-muted-foreground">Your access here cannot decide proposals.</p>;
  }
  if (props.capabilities === null) return null;
  if (!props.capabilities.configured) {
    return <p className="text-muted-foreground">Jira is not configured on this server.</p>;
  }
  if (!props.needsToken) return null;
  if (!props.capabilities.personalTokens) {
    return (
      <p className="text-muted-foreground">
        Approving writes to Jira as you, and this session cannot store a Jira token.
      </p>
    );
  }
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
      <span>Approving writes to Jira as you. Add your token for {props.site} first.</span>
      <Button size="xs" variant="outline" render={<Link to="/settings/account" />}>
        Open Account settings
      </Button>
    </p>
  );
}

function JiraDraftEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly site: string;
  readonly draft: JiraIssueDraft;
  readonly edit: JiraDraftEdit;
  readonly readMeta: boolean;
  readonly disabled: boolean;
  readonly removable: boolean;
  readonly onChange: (change: Partial<JiraDraftEdit>) => void;
  readonly onRemove: () => void;
}) {
  const { draft, edit, disabled } = props;
  const meta = useEnvironmentQuery(
    props.readMeta
      ? jiraEnvironment.createMeta({
          environmentId: props.environmentId,
          input: { site: props.site, projectKey: draft.projectKey },
        })
      : null,
  );
  const errors = jiraDraftEditErrors(edit);
  const messages = Object.values(errors);
  const issueTypes = jiraIssueTypeOptions(meta.data, edit.issueType);
  const sprints = jiraSprintOptions(meta.data, edit.sprintId);
  const details = [
    draft.projectKey,
    draft.labels.length > 0 ? `Labels ${draft.labels.join(", ")}` : null,
    draft.assigneeAccountId === null ? null : `Assignee ${draft.assigneeAccountId}`,
  ].filter((detail) => detail !== null);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <Input
          size="compact"
          className="min-w-0 flex-1"
          aria-label="Summary"
          value={edit.summary}
          disabled={disabled}
          aria-invalid={errors.summary !== undefined || undefined}
          onChange={(event) => props.onChange({ summary: event.currentTarget.value })}
        />
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Remove draft"
          disabled={disabled || !props.removable}
          onClick={props.onRemove}
        >
          <XIcon aria-hidden />
        </Button>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {meta.data === null && meta.error !== null ? (
          <Input
            size="compact"
            className="w-32"
            aria-label="Issue type"
            value={edit.issueType}
            disabled={disabled}
            aria-invalid={errors.issueType !== undefined || undefined}
            onChange={(event) => props.onChange({ issueType: event.currentTarget.value })}
          />
        ) : (
          <Select
            items={issueTypes}
            value={edit.issueType}
            disabled={disabled}
            onValueChange={(value) => {
              if (value !== null) props.onChange({ issueType: value });
            }}
          >
            <SelectTrigger size="compact" className="w-32" aria-label="Issue type">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {issueTypes.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
        <Select
          items={sprints}
          value={jiraSprintOptionValue(edit.sprintId)}
          disabled={disabled}
          onValueChange={(value) => {
            if (value !== null) props.onChange({ sprintId: jiraSprintIdFromOption(value) });
          }}
        >
          <SelectTrigger size="compact" className="w-40" aria-label="Sprint">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {sprints.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Input
          size="compact"
          className="w-20"
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          aria-label="Story points"
          placeholder="Points"
          value={edit.storyPoints}
          disabled={disabled}
          aria-invalid={errors.storyPoints !== undefined || undefined}
          onChange={(event) => props.onChange({ storyPoints: event.currentTarget.value })}
        />
        <Input
          size="compact"
          className="w-28"
          aria-label="Parent issue key"
          placeholder="Parent key"
          value={edit.parentKey}
          disabled={disabled}
          aria-invalid={errors.parentKey !== undefined || undefined}
          onChange={(event) => props.onChange({ parentKey: event.currentTarget.value })}
        />
      </div>
      {messages.length > 0 ? (
        <p className="text-xs text-destructive">{messages.join(" · ")}</p>
      ) : null}
      <p className="min-w-0 truncate text-xs text-muted-foreground">{details.join(" · ")}</p>
      {draft.description !== null && draft.description.trim().length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger render={<Button type="button" size="xs" variant="ghost-muted" />}>
            <ChevronRightIcon
              aria-hidden
              className="transition-transform in-data-panel-open:rotate-90"
            />
            Description
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="pt-1 text-sm">
              <ChatMarkdown
                text={draft.description}
                cwd={undefined}
                threadRef={props.threadRef}
                environmentId={props.environmentId}
              />
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </div>
  );
}
