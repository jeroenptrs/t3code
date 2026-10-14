import {
  CommandId,
  type JiraIssueSummary,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import { normalizeJiraSite } from "../../../jira/JiraConfig.ts";
import * as JiraIdentities from "../../../jira/JiraIdentities.ts";
import * as JiraProposals from "../../../jira/JiraProposals.ts";
import * as JiraService from "../../../jira/JiraService.ts";
import { browseUrl } from "../../../jira/issueMapping.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  JiraIssueLinkFailedError,
  JiraIssueListFailedError,
  JiraIssuesToolkit,
  JiraIssueUnlinkFailedError,
  JiraNotConfiguredError,
  JiraSiteInvalidError,
  JiraThreadNotFoundError,
  JiraThreadRequiredError,
  type JiraProposalToolResult,
  type ListThreadJiraIssuesResult,
} from "./tools.ts";

type ThreadFailure =
  | typeof JiraIssueLinkFailedError
  | typeof JiraIssueUnlinkFailedError
  | typeof JiraIssueListFailedError;

const visibleLinks = (thread: Pick<OrchestrationV2ThreadShell, "jiraIssues">) =>
  (thread.jiraIssues ?? []).filter((link) => link.source !== "branch-dismissed");

/** What the list tool reports from a thread shell. */
function listThreadJiraIssues(
  thread: Pick<OrchestrationV2ThreadShell, "jiraIssues">,
): ListThreadJiraIssuesResult {
  return {
    issues: visibleLinks(thread).map((link) => ({
      site: link.site,
      key: link.key,
      url: browseUrl(link.site, link.key),
      source: link.source,
      linkedAt: link.linkedAt,
      summary: link.snapshot?.summary ?? null,
      statusCategory: link.snapshot?.statusCategory ?? null,
      syncedAt: link.snapshot?.syncedAt ?? null,
    })),
  };
}

/** What a propose tool reports from the proposal's outcome. */
const proposalResult = (outcome: JiraProposals.JiraProposalOutcome): JiraProposalToolResult => ({
  proposalId: outcome.proposalId,
  status: outcome.status,
  ...(outcome.result === null || outcome.result.issues.length === 0
    ? {}
    : { issues: outcome.result.issues }),
  ...(outcome.error === null ? {} : { error: outcome.error }),
});

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const proposals = yield* JiraProposals.JiraProposals;
  const jira = yield* JiraService.JiraService;
  const identities = yield* JiraIdentities.JiraIdentities;
  const crypto = yield* Crypto.Crypto;
  const readerSite = identities.list.find((identity) => identity.reader)?.site ?? null;

  const commandId = (tag: string, threadId: ThreadId) =>
    crypto.randomUUIDv4().pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:${tag}:${threadId}:${uuid}`)),
    );

  const requireThread = Effect.fn("JiraIssuesToolkit.requireThread")(function* (
    Failure: ThreadFailure,
    requested: ThreadId | undefined,
  ) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const threadId = requested ?? scope.thread?.threadId;
    if (threadId === undefined) return yield* new JiraThreadRequiredError();
    const thread = yield* engine
      .getThreadShell(threadId)
      .pipe(Effect.mapError((cause) => new Failure({ cause })));
    if (thread === null || thread.deletedAt !== null) {
      return yield* new JiraThreadNotFoundError({ threadId });
    }
    return thread;
  });

  /** The site the agent named, normalized; null when it named none. */
  const explicitSite = (site: string | undefined) => {
    if (site === undefined) return Effect.succeed(null);
    const normalized = normalizeJiraSite(site);
    return normalized === null
      ? Effect.fail(new JiraSiteInvalidError())
      : Effect.succeed(normalized);
  };

  const dispatchFailure =
    (Failure: typeof JiraIssueLinkFailedError | typeof JiraIssueUnlinkFailedError) =>
    <E>(cause: Cause.Cause<E>) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.fail(new Failure({ cause }));

  /** The issue as the reader sees it, or why it cannot; a read failure never fails the link. */
  const readIssue = (site: string, key: string) =>
    jira.issuesByKeys(site, [key]).pipe(
      Effect.map((issues): { issue: JiraIssueSummary | null; note: string | null } => {
        const issue = issues.find((candidate) => candidate.key === key) ?? null;
        return {
          issue,
          note: issue === null ? `T3 Code's Jira reader cannot see ${key} on ${site}.` : null,
        };
      }),
      Effect.catchTags({
        JiraError: (error) => Effect.succeed({ issue: null, note: error.message }),
      }),
    );

  /**
   * A propose tool: records the card in the calling thread's live run and waits for the user.
   * Nothing here can approve one; only a signed-in user deciding it from a client does.
   */
  const proposes = <
    P extends {
      readonly timeoutMs?: number | undefined;
      readonly clientRequestId?: string | undefined;
    },
  >(
    tool: string,
    request: (params: P) => JiraProposals.JiraProposalRequest,
  ) =>
    McpToolAccess.actsAsCaller((params: P) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const caller = yield* McpInvocationContext.requireThreadScope(scope, tool);
        const outcome = yield* proposals.propose({
          threadId: caller.thread.threadId,
          providerInstanceId: caller.thread.providerInstanceId,
          request: request(params),
          clientRequestId: params.clientRequestId,
          timeoutMs: params.timeoutMs,
        });
        return proposalResult(outcome);
      }),
    );

  /** A tool that changes `threadId`, or the caller's own thread when it is omitted. */
  const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
    handle: (params: P) => Effect.Effect<A, E, R>,
  ) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

  return {
    link_jira_issue: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(JiraIssueLinkFailedError, input.threadId);
        const site = (yield* explicitSite(input.site)) ?? readerSite;
        if (site === null) return yield* new JiraNotConfiguredError();
        const alreadyLinked = visibleLinks(thread).some(
          (link) => link.site === site && link.key === input.key,
        );
        if (!alreadyLinked) {
          yield* engine
            .dispatch({
              type: "thread.jira-issue.link",
              commandId: yield* commandId("mcp-jira-link", thread.id),
              threadId: thread.id,
              site,
              key: input.key,
              source: "agent",
            })
            .pipe(Effect.catchCause(dispatchFailure(JiraIssueLinkFailedError)));
        }
        const { issue, note } = yield* readIssue(site, input.key);
        return {
          site,
          key: input.key,
          url: browseUrl(site, input.key),
          alreadyLinked,
          issue:
            issue === null
              ? null
              : {
                  summary: issue.summary,
                  status: issue.status,
                  statusCategory: issue.statusCategory,
                },
          note,
        };
      }),
    ),
    unlink_jira_issue: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(JiraIssueUnlinkFailedError, input.threadId);
        const site = yield* explicitSite(input.site);
        const matches = visibleLinks(thread).filter(
          (link) => link.key === input.key && (site === null || link.site === site),
        );
        // Without a site, the reader's link wins; a key linked on one site only needs no site.
        const target = matches.find((link) => link.site === readerSite) ?? matches[0];
        if (target === undefined) {
          return { site: site ?? readerSite, key: input.key, wasLinked: false };
        }
        yield* engine
          .dispatch({
            type: "thread.jira-issue.unlink",
            commandId: yield* commandId("mcp-jira-unlink", thread.id),
            threadId: thread.id,
            site: target.site,
            key: target.key,
          })
          .pipe(Effect.catchCause(dispatchFailure(JiraIssueUnlinkFailedError)));
        return { site: target.site, key: target.key, wasLinked: true };
      }),
    ),
    list_thread_jira_issues: McpToolAccess.reads((input) =>
      requireThread(JiraIssueListFailedError, input.threadId).pipe(
        Effect.map(listThreadJiraIssues),
      ),
    ),
    propose_jira_issues: proposes("propose_jira_issues", (input) => ({
      kind: "create-issues",
      site: input.site,
      issues: input.issues,
    })),
    propose_jira_comment: proposes("propose_jira_comment", (input) => ({
      kind: "comment",
      site: input.site,
      key: input.key,
      body: input.body,
    })),
    propose_jira_transition: proposes("propose_jira_transition", (input) => ({
      kind: "transition",
      site: input.site,
      key: input.key,
      transition: input.transition,
      comment: input.comment,
    })),
  } satisfies McpToolAccess.Handlers<typeof JiraIssuesToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(JiraIssuesToolkit, make);
