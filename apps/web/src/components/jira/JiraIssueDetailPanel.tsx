/**
 * A Jira issue beside a thread, read lazily through the environment's reader identity, or the
 * signed-in user's own token on their site. A user with a token for the issue's site can also
 * comment and move the issue as themselves; assignment stays in Jira for now.
 */
import { useAtomValue } from "@effect/atom-react";
import { jiraIssueUrl } from "@t3tools/client-runtime/state/jira";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  JiraIssueDetail,
  JiraIssueKey,
  JiraLinkedPullRequest,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ExternalLinkIcon } from "lucide-react";
import { useRef, useState, type MouseEvent, type ReactNode } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { cn } from "~/lib/utils";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { jiraEnvironment, jiraFailureReason, useJiraCapabilities } from "~/state/jira";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import ChatMarkdown from "../ChatMarkdown";
import { JiraIcon } from "../Icons";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { personalCredentialForSite } from "./jiraIssueList.logic";
import { jiraCommentToPost, jiraIssueWriteAccess } from "./jiraIssueWrite.logic";
import { jiraProposalFailureMessage } from "./jiraProposal.logic";
import { JiraConfigurationSteps, JiraStatusBadge, JiraStatusDot } from "./jiraPresentation";

/** Opens Jira where the "Open links in" setting says, for anchors that point at it. */
function useOpenJiraLink(threadRef: ScopedThreadRef) {
  const openLink = useOpenLink(threadRef);
  return (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const url = event.currentTarget.href;
    void openLink(url, { event }).catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Unable to open Jira",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  };
}

function JiraIssueUnavailable(props: {
  title: string;
  description: ReactNode;
  url?: string;
  onRetry?: () => void;
  refreshing?: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Empty>
        <EmptyMedia variant="icon">
          <JiraIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>{props.title}</EmptyTitle>
          <EmptyDescription>{props.description}</EmptyDescription>
        </EmptyHeader>
        {props.onRetry || props.url ? (
          <div className="flex flex-wrap justify-center gap-2">
            {props.onRetry ? (
              <Button
                size="sm"
                variant="outline"
                onClick={props.onRetry}
                disabled={props.refreshing}
                aria-busy={props.refreshing}
              >
                <RefreshIcon size="sm" refreshing={props.refreshing ?? false} />
                Retry
              </Button>
            ) : null}
            {props.url ? (
              <Button
                size="sm"
                variant="outline"
                render={<a href={props.url} target="_blank" rel="noopener noreferrer" />}
              >
                <ExternalLinkIcon aria-hidden className="size-3.5" />
                Open in Jira
              </Button>
            ) : null}
          </div>
        ) : null}
      </Empty>
    </div>
  );
}

export function JiraIssueDetailPanel(props: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  issue: JiraIssueKey;
}) {
  const { environmentId, threadRef, issue } = props;
  const capabilities = useJiraCapabilities(environmentId);
  const target = { environmentId, input: { site: issue.site, key: issue.key } };
  const query = useEnvironmentQuery(
    capabilities?.configured === true ? jiraEnvironment.issue(target) : null,
  );
  const refresh = () => jiraEnvironment.refreshIssue(appAtomRegistry, target);
  const url = jiraIssueUrl(issue);

  if (capabilities !== null && !capabilities.configured) {
    return (
      <JiraIssueUnavailable
        title="Jira is not configured"
        description={
          <>
            This server has no Jira identity to read {issue.key} with. <JiraConfigurationSteps />
          </>
        }
        url={url}
      />
    );
  }
  if (capabilities === null || (query.data === null && query.error === null)) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-muted-foreground text-sm">
        Loading {issue.key}…
      </div>
    );
  }
  if (query.data === null) {
    const reason = jiraFailureReason(query.failure);
    const usesPersonalToken = personalCredentialForSite(capabilities, issue.site) !== null;
    return (
      <JiraIssueUnavailable
        title={
          reason === "not-found"
            ? `${issue.key} is not available`
            : reason === "unauthorized" || reason === "forbidden"
              ? !usesPersonalToken
                ? "Jira refused the reader"
                : "Jira refused your token"
              : `Could not load ${issue.key}`
        }
        description={
          reason === "not-found"
            ? `The issue does not exist on ${issue.site}, or the server's reader identity cannot see it.`
            : reason === "unauthorized" || reason === "forbidden"
              ? !usesPersonalToken
                ? `Jira refused the server's reader identity${capabilities.reader ? ` (${capabilities.reader.name})` : ""}. Check its token and project permissions.`
                : "Check your token and project permissions in Settings → Account."
              : (query.error ?? "The request failed.")
        }
        url={url}
        onRetry={refresh}
        refreshing={query.isPending}
      />
    );
  }
  return (
    <JiraIssueDetailContent
      detail={query.data}
      environmentId={environmentId}
      threadRef={threadRef}
      refreshing={query.isPending}
      onRefresh={refresh}
    />
  );
}

function DetailSection(props: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-border/65 px-4 py-3">
      <h3 className="font-medium text-muted-foreground text-xs">{props.title}</h3>
      {props.children}
    </section>
  );
}

function MetaRow(props: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 truncate">{props.children}</dd>
    </>
  );
}

function JiraIssueDetailContent(props: {
  detail: JiraIssueDetail;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { detail, environmentId, threadRef } = props;
  const openJira = useOpenJiraLink(threadRef);
  const capabilities = useJiraCapabilities(environmentId);
  const canOperate = useAtomValue(jiraEnvironment.addComment.permissionAtom(environmentId));
  const writeAccess = jiraIssueWriteAccess({ capabilities, canOperate, site: detail.site });
  const hiddenComments = detail.commentCount - detail.comments.length;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="flex flex-col gap-2 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <JiraIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <a
            href={detail.url}
            onClick={openJira}
            className="inline-flex min-w-0 items-center gap-1 font-medium hover:underline"
          >
            {detail.key}
            <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          </a>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh issue"
            onClick={props.onRefresh}
            disabled={props.refreshing}
          >
            <RefreshIcon refreshing={props.refreshing} />
          </Button>
        </div>
        <h2 className="font-semibold text-base leading-snug">{detail.summary}</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <JiraStatusBadge category={detail.statusCategory} status={detail.status} />
          {detail.issueType ? (
            <span className="text-muted-foreground text-xs">{detail.issueType}</span>
          ) : null}
          {detail.priority ? (
            <span className="text-muted-foreground text-xs">· {detail.priority} priority</span>
          ) : null}
          {writeAccess === "enabled" && detail.transitions.length > 0 ? (
            <JiraTransitionMenu environmentId={environmentId} detail={detail} />
          ) : null}
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
          <MetaRow label="Assignee">{detail.assignee?.displayName ?? "Unassigned"}</MetaRow>
          {detail.reporter ? (
            <MetaRow label="Reporter">{detail.reporter.displayName}</MetaRow>
          ) : null}
          {detail.sprints.length > 0 ? (
            <MetaRow label={detail.sprints.length === 1 ? "Sprint" : "Sprints"}>
              {detail.sprints.map((sprint) => sprint.name).join(", ")}
            </MetaRow>
          ) : null}
          {detail.storyPoints !== null ? (
            <MetaRow label="Story points">{detail.storyPoints}</MetaRow>
          ) : null}
          {detail.updated ? (
            <MetaRow label="Updated">{formatRelativeTimeLabel(detail.updated)}</MetaRow>
          ) : null}
        </dl>
      </header>

      <DetailSection title="Description">
        {detail.description ? (
          <ChatMarkdown
            text={detail.description}
            cwd={undefined}
            threadRef={threadRef}
            environmentId={environmentId}
          />
        ) : (
          <p className="text-muted-foreground text-sm">No description.</p>
        )}
      </DetailSection>

      {detail.pullRequests.length > 0 ? (
        <DetailSection title="Pull requests">
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {detail.pullRequests.map((pullRequest) => (
              <JiraLinkedPullRequestRow
                key={`${pullRequest.host}/${pullRequest.repository}#${pullRequest.number}`}
                pullRequest={pullRequest}
                threadRef={threadRef}
              />
            ))}
          </ul>
        </DetailSection>
      ) : null}

      {detail.linkedThreads.length > 0 ? (
        <DetailSection title="Threads">
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm">
            {detail.linkedThreads.map((thread) => (
              <li key={thread.id} className="flex min-w-0 items-baseline gap-2">
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId, threadId: thread.id }}
                  className="min-w-0 truncate hover:underline"
                >
                  {thread.title}
                </Link>
                <span className="shrink-0 text-muted-foreground text-xs">
                  {thread.id === threadRef.threadId
                    ? "this thread"
                    : thread.archivedAt !== null
                      ? "archived"
                      : null}
                </span>
              </li>
            ))}
          </ul>
        </DetailSection>
      ) : null}

      <DetailSection
        title={detail.commentCount === 0 ? "Comments" : `Comments (${detail.commentCount})`}
      >
        {detail.comments.length === 0 ? (
          <p className="text-muted-foreground text-sm">No comments.</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {hiddenComments > 0 ? (
              <li className="text-xs">
                <a
                  href={detail.url}
                  onClick={openJira}
                  className="text-muted-foreground hover:underline"
                >
                  {hiddenComments} more in Jira
                </a>
              </li>
            ) : null}
            {detail.comments.map((comment) => (
              <li key={comment.id} className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2 text-xs">
                  <span className="font-medium">{comment.author?.displayName ?? "Unknown"}</span>
                  <time dateTime={comment.created} className="text-muted-foreground">
                    {formatRelativeTimeLabel(comment.created)}
                  </time>
                </div>
                <ChatMarkdown
                  text={comment.body}
                  cwd={undefined}
                  threadRef={threadRef}
                  environmentId={environmentId}
                />
              </li>
            ))}
          </ol>
        )}
        {writeAccess === "enabled" ? (
          <JiraCommentComposer environmentId={environmentId} detail={detail} />
        ) : writeAccess === "needs-token" ? (
          <p className="text-muted-foreground text-xs">
            Commenting and moving issues as yourself needs your Jira token in{" "}
            <Link to="/settings/account" className="underline">
              Settings → Account
            </Link>
            .
          </p>
        ) : null}
      </DetailSection>
    </div>
  );
}

type JiraWriteFailure = { readonly message: string; readonly needsToken: boolean };

function jiraWriteFailure(failure: unknown): JiraWriteFailure {
  return {
    message: jiraProposalFailureMessage(failure),
    needsToken: jiraFailureReason(failure) === "personal-token-required",
  };
}

/** The server's refusal, or where to add the token it asked for. */
function JiraWriteError(props: { failure: JiraWriteFailure; site: string }) {
  return (
    <p role="alert" className="text-destructive text-xs">
      {props.failure.needsToken ? (
        <>
          Add your Jira token for {props.site} in{" "}
          <Link to="/settings/account" className="underline">
            Settings → Account
          </Link>{" "}
          first.
        </>
      ) : (
        props.failure.message
      )}
    </p>
  );
}

/** Posts markdown as the signed-in user. The draft stays until Jira accepts it. */
function JiraCommentComposer(props: { environmentId: EnvironmentId; detail: JiraIssueDetail }) {
  const { environmentId, detail } = props;
  const addComment = useAtomCommand(jiraEnvironment.addComment, {
    label: "add Jira comment",
    // The composer shows the failure inline.
    reportFailure: false,
  });
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [failure, setFailure] = useState<JiraWriteFailure | null>(null);
  // Two submits can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const body = jiraCommentToPost(draft);

  const post = async () => {
    if (body === null || inFlight.current) return;
    inFlight.current = true;
    setPosting(true);
    setFailure(null);
    const result = await addComment({
      environmentId,
      input: { site: detail.site, key: detail.key, body },
    }).finally(() => {
      inFlight.current = false;
      setPosting(false);
    });
    if (result._tag === "Success") setDraft("");
    else if (!isAtomCommandInterrupted(result)) {
      setFailure(jiraWriteFailure(squashAtomCommandFailure(result)));
    }
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void post();
      }}
    >
      <Textarea
        size="sm"
        aria-label="Add a comment"
        placeholder="Add a comment (markdown)"
        value={draft}
        disabled={posting}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void post();
          }
        }}
      />
      <div className="flex min-w-0 items-center justify-end gap-2">
        <div className="min-w-0 flex-1">
          {failure !== null ? <JiraWriteError failure={failure} site={detail.site} /> : null}
        </div>
        <Button type="submit" size="sm" disabled={posting || body === null}>
          {posting ? "Posting…" : "Post"}
        </Button>
      </div>
    </form>
  );
}

/** Lists the transitions Jira offers the user on this issue; picking one moves it. */
function JiraTransitionMenu(props: { environmentId: EnvironmentId; detail: JiraIssueDetail }) {
  const { environmentId, detail } = props;
  const transition = useAtomCommand(jiraEnvironment.transitionIssue, {
    label: "move Jira issue",
    reportFailure: false,
  });
  const [moving, setMoving] = useState(false);
  const [failure, setFailure] = useState<JiraWriteFailure | null>(null);
  const inFlight = useRef(false);

  const move = async (transitionId: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setMoving(true);
    setFailure(null);
    const result = await transition({
      environmentId,
      input: { site: detail.site, key: detail.key, transitionId },
    }).finally(() => {
      inFlight.current = false;
      setMoving(false);
    });
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      setFailure(jiraWriteFailure(squashAtomCommandFailure(result)));
    }
  };

  return (
    <>
      <span className="flex-1" />
      <Menu>
        <MenuTrigger
          render={
            <Button size="xs" variant="outline" disabled={moving} aria-busy={moving}>
              {moving ? "Moving…" : "Move to…"}
              <ChevronDownIcon aria-hidden className="size-3.5" />
            </Button>
          }
        />
        <MenuPopup align="end">
          {detail.transitions.map((option) => (
            <MenuItem key={option.id} onClick={() => void move(option.id)}>
              <JiraStatusDot category={option.toStatusCategory} />
              {option.name === option.toStatus
                ? option.name
                : `${option.name} → ${option.toStatus}`}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      {failure !== null ? (
        <div className="basis-full">
          <JiraWriteError failure={failure} site={detail.site} />
        </div>
      ) : null}
    </>
  );
}

/** Opens in the pull request tab where a project here can read it, otherwise at the host. */
function JiraLinkedPullRequestRow(props: {
  pullRequest: JiraLinkedPullRequest;
  threadRef: ScopedThreadRef;
}) {
  const { pullRequest } = props;
  const openPrLink = useOpenPrLink(props.threadRef);
  const state =
    pullRequest.state === null
      ? null
      : resolvePullRequestState({ state: pullRequest.state, isDraft: false });
  return (
    <li className="flex min-w-0 items-center gap-2 text-sm">
      {state ? (
        <state.Icon
          aria-label={state.label}
          className={cn("size-3.5 shrink-0", state.toneClassName)}
        />
      ) : null}
      <a
        href={pullRequest.url}
        onClick={(event) => openPrLink(event, pullRequest.url)}
        className="min-w-0 truncate hover:underline"
      >
        {pullRequest.title}
      </a>
      <span className="shrink-0 text-muted-foreground text-xs">
        {pullRequest.repository}#{pullRequest.number}
      </span>
    </li>
  );
}
