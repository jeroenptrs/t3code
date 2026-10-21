/**
 * JiraBreakdownService - breaks a Jira issue into work packages in a thread the server starts.
 *
 * A breakdown is an ordinary thread: the server launches it in the chosen project with the issue
 * and its planning context as the first message, and its agent proposes the packages with
 * `propose_jira_issues`. Approval, the approver's personal token, and linking created issues back
 * to the thread are the proposal flow's own. Only a caller with a personal token for the issue's
 * site may start one, since only they could approve what it proposes.
 *
 * `fork_jira_breakdowns` marks the thread as a breakdown, which `JiraBreakdownThreads` reads to
 * grant its agent the breakdown instructions, and records how its first run ended. A run that
 * proposes nothing leaves a notice in the thread saying why.
 *
 * @module JiraBreakdownService
 */
import {
  type AuthUserId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  JiraError,
  type JiraBreakdownStartInput,
  type JiraBreakdownStartResult,
  type JiraCreateMeta,
  type JiraIssueDetail,
  type JiraVelocityResult,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ProjectId,
  ThreadId,
  TurnItemId,
  jiraProjectKeyOf,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as JiraApi from "./JiraApi.ts";
import { type JiraServerIdentity, normalizeJiraSite } from "./JiraConfig.ts";
import * as JiraService from "./JiraService.ts";
import * as JiraUserCredentials from "./JiraUserCredentials.ts";
import { makeKeyedLock } from "./keyedLock.ts";

const JiraBreakdownStatus = Schema.Literals(["running", "proposed", "no-proposal", "failed"]);
type JiraBreakdownStatus = typeof JiraBreakdownStatus.Type;

export class JiraBreakdownService extends Context.Service<
  JiraBreakdownService,
  {
    /**
     * Starts a breakdown of the issue in `input.projectId` and returns its thread once launched;
     * the agent runs in the background, in a worktree of its own. Joins a breakdown of the same
     * issue still running in the same project, with `started: false`. Refused, launching nothing,
     * when the caller is not signed in, has no personal token for the issue's site, or the project
     * has no default model.
     */
    readonly start: (
      userId: AuthUserId | undefined,
      input: JiraBreakdownStartInput,
    ) => Effect.Effect<JiraBreakdownStartResult, JiraError>;
    /**
     * Follows the breakdown in `threadId` until its first run ends, then records how it ended
     * and returns that. Joins the follower already running for the thread; a breakdown that
     * already ended returns its stored status, and a thread that is not one returns null.
     * `start` and server startup run it in the background.
     */
    readonly follow: (threadId: ThreadId) => Effect.Effect<JiraBreakdownStatus | null>;
  }
>()("t3/jira/JiraBreakdownService") {}

const BreakdownRow = Schema.Struct({
  threadId: Schema.String,
  status: JiraBreakdownStatus,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(BreakdownRow));

/** How long one wait for the first run lasts before it is taken again; runs can take hours. */
const RUN_WAIT_MS = 24 * 60 * 60 * 1_000;
const TITLE_LIMIT = 80;
const DESCRIPTION_LIMIT = 20_000;
const COMMENT_COUNT = 10;
const COMMENT_LIMIT = 2_000;
const REASON_LIMIT = 400;
const NO_FINAL_MESSAGE = "The agent gave no final message.";

const signInRequired = new JiraError({
  reason: "forbidden",
  message: "Sign in to T3 Code with your organisation account to break down a Jira issue.",
});

const personalTokenRequired = new JiraError({
  reason: "personal-token-required",
  message:
    "Add your own Jira token in Settings → Account to break down this issue. Only you can approve the work packages it proposes.",
});

const unavailable = (message: string) => new JiraError({ reason: "unavailable", message });

const truncate = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;

const oneLine = (text: string) => text.replaceAll(/\s+/g, " ").trim();

/** The issue's parent and hierarchy level, read beside the detail; neither is in the contract. */
interface IssueHierarchy {
  readonly level: "epic" | "standard" | "sub-task" | null;
  readonly parent: {
    readonly key: string;
    readonly summary: string | null;
    readonly issueType: string | null;
  } | null;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const toIssueHierarchy = (fields: Record<string, unknown> | undefined): IssueHierarchy => {
  const issueType = record(fields?.issuetype);
  const hierarchyLevel = issueType?.hierarchyLevel;
  const level =
    issueType?.subtask === true || hierarchyLevel === -1
      ? "sub-task"
      : typeof hierarchyLevel === "number" && hierarchyLevel >= 1
        ? "epic"
        : hierarchyLevel === 0
          ? "standard"
          : null;
  const parent = record(fields?.parent);
  const parentKey = text(parent?.key);
  const parentFields = record(parent?.fields);
  return {
    level,
    parent:
      parentKey === null
        ? null
        : {
            key: parentKey,
            summary: text(parentFields?.summary),
            issueType: text(record(parentFields?.issuetype)?.name),
          },
  };
};

/** The first message of a breakdown thread: the issue, then what the team plans with. */
const breakdownMessage = (input: {
  readonly issue: JiraIssueDetail;
  readonly hierarchy: IssueHierarchy;
  readonly projectKey: string;
  readonly createMeta: JiraCreateMeta | null;
  readonly velocity: JiraVelocityResult | null;
}): string => {
  const { issue, hierarchy, createMeta, velocity } = input;
  const level = hierarchy.level === null ? "" : ` (${hierarchy.level} level)`;
  const parent =
    hierarchy.parent === null
      ? "none"
      : `${hierarchy.parent.key}${hierarchy.parent.issueType === null ? "" : ` (${hierarchy.parent.issueType})`}${hierarchy.parent.summary === null ? "" : `: ${hierarchy.parent.summary}`}`;
  const description =
    issue.description === null || issue.description.trim().length === 0
      ? "_No description._"
      : truncate(issue.description.trim(), DESCRIPTION_LIMIT);
  const comments = issue.comments.slice(-COMMENT_COUNT);
  const commentLines =
    comments.length === 0
      ? ["_No comments._"]
      : comments.map((comment) => {
          const author = comment.author?.displayName ?? "Someone";
          const body = truncate(comment.body.trim(), COMMENT_LIMIT).replaceAll("\n", "\n> ");
          return `**${author}** on ${comment.created.slice(0, 10)}:\n> ${body}`;
        });
  const issueTypes =
    createMeta === null
      ? "could not be read"
      : createMeta.issueTypes.length === 0
        ? "none listed"
        : createMeta.issueTypes
            .map((type) => (type.subtask ? `${type.name} (sub-task)` : type.name))
            .join(", ");
  const openSprints = (createMeta?.sprints ?? []).filter((sprint) => sprint.state !== "closed");
  const sprintLines =
    createMeta === null
      ? ["- Open sprints: could not be read"]
      : openSprints.length === 0
        ? ["- Open sprints: none"]
        : [
            "- Open sprints:",
            ...openSprints.map(
              (sprint) =>
                `  - ${sprint.name} (sprintId ${sprint.id}, ${sprint.state}${sprint.endDate === null ? "" : `, ends ${sprint.endDate.slice(0, 10)}`})`,
            ),
          ];
  const velocityLine =
    velocity === null
      ? "could not be read"
      : velocity.averageCompletedPoints === null
        ? "no closed sprints to measure"
        : `${Math.round(velocity.averageCompletedPoints * 10) / 10} points completed per sprint, averaged over the last ${velocity.sprints.length} closed sprints${velocity.partial ? " (older sprints may be undercounted)" : ""}`;
  return [
    `Break down Jira issue ${issue.key} into independently mergeable work packages and propose them with propose_jira_issues.`,
    "Read the repository to understand the work, but do not edit files, commit, push, or open pull requests before proposing.",
    "",
    `## ${issue.key}: ${issue.summary}`,
    "",
    `- Type: ${issue.issueType ?? "unknown"}${level}`,
    `- Status: ${issue.status}`,
    `- Story points: ${issue.storyPoints ?? "none"}`,
    `- Parent: ${parent}`,
    `- Link: ${issue.url}`,
    "",
    "### Description",
    "",
    description,
    "",
    `### Latest comments (${comments.length} of ${issue.commentCount})`,
    "",
    commentLines.join("\n\n"),
    "",
    "## Planning context",
    "",
    `- Site: ${issue.site}`,
    `- Project key: ${input.projectKey}`,
    `- Issue types: ${issueTypes}`,
    ...sprintLines,
    `- Velocity: ${velocityLine}`,
  ].join("\n");
};

const RUN_ENDED: Record<OrchestrationV2Run["status"], string> = {
  preparing: "The run did not finish.",
  queued: "The run did not finish.",
  starting: "The run did not finish.",
  running: "The run did not finish.",
  waiting: "The run did not finish.",
  completed: NO_FINAL_MESSAGE,
  failed: "The run failed.",
  cancelled: "The run was cancelled.",
  interrupted: "The run was interrupted.",
  rolled_back: "The run was rolled back.",
};

/**
 * Why a run proposed nothing: a run that did not complete failed, with its last error; one that
 * completed gives the agent's last message, which the instructions ask to say why.
 */
const noProposalOutcome = (
  run: OrchestrationV2Run,
  chain: ReadonlySet<string>,
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): { readonly status: JiraBreakdownStatus; readonly reason: string } => {
  const inChain = (runId: string | null) => runId !== null && chain.has(runId);
  if (run.status !== "completed") {
    const failure = turnItems
      .flatMap((item) =>
        item.type === "error" && inChain(item.runId) ? [item.failure.message] : [],
      )
      .at(-1);
    return {
      status: "failed",
      reason: truncate(oneLine(failure ?? RUN_ENDED[run.status]), REASON_LIMIT),
    };
  }
  const lastWord = messages
    .filter((message) => message.role === "assistant" && inChain(message.runId))
    .map((message) => oneLine(message.text))
    .findLast((message) => message.length > 0);
  return {
    status: "no-proposal",
    reason: lastWord === undefined ? NO_FINAL_MESSAGE : truncate(lastWord, REASON_LIMIT),
  };
};

/** The thread's first run and the runs that continued it after restarts. */
const continuationChain = (
  runs: ReadonlyArray<OrchestrationV2Run>,
  first: OrchestrationV2Run,
): ReadonlySet<string> => {
  const chain = new Set<string>([first.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const run of runs) {
      if (
        !chain.has(run.id) &&
        run.restartContinuationOfRunId !== undefined &&
        chain.has(run.restartContinuationOfRunId)
      ) {
        chain.add(run.id);
        grew = true;
      }
    }
  }
  return chain;
};

const make = Effect.gen(function* () {
  const jira = yield* JiraService.JiraService;
  const api = yield* JiraApi.JiraApi;
  const credentials = yield* JiraUserCredentials.JiraUserCredentials;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const sql = yield* SqlClient.SqlClient;
  // Followers outlive the request that started them and end with the server.
  const serviceScope = yield* Effect.scope;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  /** Two presses for one issue start one thread: the second waits, then joins the first. */
  const claims = makeKeyedLock<string>().withLock;
  const followers = new Map<string, Fiber.Fiber<JiraBreakdownStatus | null>>();
  const followerLock = yield* Semaphore.make(1);

  const ledgerFailed = (cause: unknown) =>
    Effect.logWarning("Could not read or record a Jira breakdown", { cause }).pipe(
      Effect.andThen(Effect.fail(unavailable("Could not read or record the breakdown."))),
    );

  const readStatus = Effect.fn("JiraBreakdownService.readStatus")(function* (threadId: ThreadId) {
    const rows = yield* sql`
      SELECT thread_id AS "threadId", status FROM fork_jira_breakdowns
      WHERE thread_id = ${threadId}
    `.pipe(Effect.flatMap(decodeRows));
    return rows[0]?.status ?? null;
  });

  const finish = Effect.fn("JiraBreakdownService.finish")(function* (
    threadId: ThreadId,
    status: JiraBreakdownStatus,
    reason: string | null,
  ) {
    yield* sql`
      UPDATE fork_jira_breakdowns
      SET status = ${status}, reason = ${reason}, finished_at = ${yield* nowIso}
      WHERE thread_id = ${threadId} AND status = 'running'
    `;
    return status;
  });

  /**
   * A thread still running a breakdown of the issue in the project; one whose thread is gone
   * does not count.
   */
  const runningBreakdown = Effect.fn("JiraBreakdownService.runningBreakdown")(function* (
    site: string,
    key: string,
    projectId: ProjectId,
  ) {
    const rows = yield* sql`
        SELECT thread_id AS "threadId", status FROM fork_jira_breakdowns
        WHERE site = ${site} AND issue_key = ${key} AND status = 'running'
        ORDER BY created_at DESC
      `.pipe(Effect.flatMap(decodeRows));
    for (const row of rows) {
      const threadId = ThreadId.make(row.threadId);
      const shell = yield* orchestrator.getThreadShell(threadId);
      if (shell !== null && shell.deletedAt === null && shell.projectId === projectId) {
        return threadId;
      }
    }
    return null;
  }, Effect.catch(ledgerFailed));

  /** What the agent is told, read as the caller. Only the issue itself is required. */
  const readContext = Effect.fn("JiraBreakdownService.readContext")(function* (
    userId: AuthUserId,
    identity: JiraServerIdentity,
    key: string,
  ) {
    const site = identity.site;
    const asCaller = { actingUserId: userId };
    const projectKey = jiraProjectKeyOf(key);
    const optional = <A>(label: string, effect: Effect.Effect<A, JiraError>) =>
      effect.pipe(
        Effect.catchTags({
          JiraError: (error) =>
            error.reason === "unauthorized"
              ? Effect.fail(error)
              : Effect.logWarning("Could not read Jira planning context for a breakdown", {
                  read: label,
                  reason: error.reason,
                }).pipe(Effect.as(null)),
        }),
      );
    const [issue, createMeta, velocity] = yield* Effect.all(
      [
        jira.issue({ site, key }, asCaller),
        optional("createMeta", jira.createMeta({ site, projectKey }, asCaller)),
        optional("velocity", jira.velocity({ site, projectKey }, asCaller)),
      ],
      { concurrency: "unbounded" },
    );
    const hierarchy = yield* api.getIssue(identity, key, { fields: ["parent", "issuetype"] }).pipe(
      Effect.map((raw) => toIssueHierarchy(raw.fields)),
      Effect.catchTags({
        JiraError: (error) =>
          Effect.logWarning("Could not read a Jira issue's parent for a breakdown", {
            reason: error.reason,
          }).pipe(Effect.as<IssueHierarchy>({ level: null, parent: null })),
      }),
    );
    return {
      issue,
      message: breakdownMessage({ issue, hierarchy, projectKey, createMeta, velocity }),
    };
  });

  const resolveLaunchSettings = Effect.fn("JiraBreakdownService.resolveLaunchSettings")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects.getById(projectId).pipe(
      Effect.catch(ledgerFailed),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new JiraError({ reason: "invalid", message: "The project does not exist." }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(() => unavailable("Could not read the server's settings.")),
    );
    const resolved = resolveProjectSettings(settings, project.id, project).settings;
    const modelSelection = resolved.defaultModelSelection ?? project.defaultModelSelection ?? null;
    if (modelSelection === null) {
      return yield* new JiraError({
        reason: "invalid",
        message: `${project.title} has no default model. Choose one in its settings, then break the issue down again.`,
      });
    }
    return {
      modelSelection,
      runtimeMode: resolved.defaultRuntimeMode,
      workspaceRoot: project.workspaceRoot,
    };
  });

  /**
   * Where the agent works: a worktree from the project's current branch, or its commit when
   * detached, so it cannot touch the user's checkout. Its branch carries the issue key, so the
   * branch link detector agrees with the link the breakdown makes. A project Git cannot read,
   * such as one that is not a repository, works in its checkout.
   */
  const workspaceStrategy = Effect.fn("JiraBreakdownService.workspaceStrategy")(
    function* (workspaceRoot: string, key: string) {
      const branch = yield* git.resolveBranchName(workspaceRoot, "HEAD");
      const baseRef =
        branch ?? (yield* git.resolveCommit({ cwd: workspaceRoot, revision: "HEAD" })).commitSha;
      const existing = yield* git.listLocalBranchNames(workspaceRoot);
      return {
        type: "worktree",
        baseRef,
        branch: resolveAutoFeatureBranchName(existing, `jira/${key.toLowerCase()}-breakdown`),
        startFromOrigin: false,
      } satisfies ThreadLaunch.ThreadLaunchWorkspaceStrategy;
    },
    Effect.catchTags({
      GitCommandError: (error) =>
        Effect.logWarning("Could not resolve a worktree base for a Jira breakdown", {
          operation: error.operation,
        }).pipe(Effect.as<ThreadLaunch.ThreadLaunchWorkspaceStrategy>({ type: "root" })),
    }),
  );

  /** Waits for the thread's first run, following restarts, and records how it ended. */
  const watch = Effect.fn("JiraBreakdownService.watch")(function* (threadId: ThreadId) {
    const stored = yield* readStatus(threadId);
    if (stored !== "running") return stored;
    const deleted = orchestrator
      .getThreadShell(threadId)
      .pipe(Effect.map((current) => current === null || current.deletedAt !== null));
    const shell = yield* orchestrator.getThreadShell(threadId);
    if (shell === null || shell.deletedAt !== null) {
      return yield* finish(threadId, "failed", "The breakdown thread was deleted.");
    }
    const first = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs
      .filter((run) => run.restartContinuationOfRunId === undefined)
      .toSorted((left, right) => left.ordinal - right.ordinal)[0];
    if (first === undefined) {
      return yield* finish(threadId, "failed", "The breakdown thread never started a run.");
    }
    let ended: OrchestrationV2Run | null = null;
    while (ended === null) {
      const waited = yield* threads
        .waitForThread({
          projectId: shell.projectId,
          threadId,
          runId: first.id,
          timeoutMs: RUN_WAIT_MS,
        })
        .pipe(
          Effect.catch((error) =>
            deleted.pipe(
              Effect.flatMap((isDeleted) =>
                isDeleted ? Effect.succeed(null) : Effect.fail(error),
              ),
            ),
          ),
        );
      if (waited === null) {
        return yield* finish(threadId, "failed", "The breakdown thread was deleted.");
      }
      if (!waited.timedOut) ended = waited.run;
    }
    const records = yield* orchestrator.getThreadRecords(
      threadId,
      ["runs", "messages", "turnItems"],
      { messageRoles: ["assistant"], turnItemTypes: ["jira_proposal", "error"] },
    );
    const chain = continuationChain(records.runs, first);
    const proposed = records.turnItems.some(
      (item) => item.type === "jira_proposal" && item.runId !== null && chain.has(item.runId),
    );
    if (proposed) return yield* finish(threadId, "proposed", null);
    const { status, reason } = noProposalOutcome(ended, chain, records.messages, records.turnItems);
    // Recorded before the row, so a restart in between records the same notice again.
    if (ended.rootNodeId !== null) {
      yield* orchestrator.dispatch({
        type: "system_notice.record",
        commandId: CommandId.make(`jira-breakdown:${threadId}:notice`),
        threadId,
        runId: ended.id,
        nodeId: ended.rootNodeId,
        turnItemId: TurnItemId.make(
          `turn-item:jira-breakdown:${encodeURIComponent(threadId)}:notice`,
        ),
        message: `The breakdown ended without proposing work packages. ${reason}`,
      });
    }
    return yield* finish(threadId, status, reason);
  });

  /** The thread's follower, started in the service scope unless one is already running. */
  const follower = Effect.fn("JiraBreakdownService.follower")(function* (threadId: ThreadId) {
    const existing = followers.get(threadId);
    if (existing !== undefined) return existing;
    const fiber = yield* watch(threadId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? // Left running: the next startup follows it again.
            Effect.interrupt
          : Effect.logWarning("Could not follow a Jira breakdown", {
              threadId,
              cause: Cause.pretty(cause),
            }).pipe(
              // Ended, so the next press starts a new breakdown instead of joining this one.
              Effect.andThen(finish(threadId, "failed", "T3 Code could not follow the run.")),
              Effect.catch((error) =>
                Effect.logWarning("Could not record a Jira breakdown as failed", {
                  threadId,
                  errorTag: error._tag,
                }).pipe(Effect.as<JiraBreakdownStatus | null>("running")),
              ),
            ),
      ),
      // Waits for the lock, so it runs after the fiber is stored even if it ends at once.
      Effect.ensuring(followerLock.withPermits(1)(Effect.sync(() => followers.delete(threadId)))),
      Effect.forkIn(serviceScope),
    );
    followers.set(threadId, fiber);
    return fiber;
  }, followerLock.withPermits(1));

  const follow: JiraBreakdownService["Service"]["follow"] = Effect.fn(
    "JiraBreakdownService.follow",
  )(
    function* (threadId) {
      return yield* Fiber.join(yield* follower(threadId));
    },
    // Only an interrupted follower lands here: the server is stopping, and the breakdown is
    // followed again at the next startup.
    Effect.catchCause(() => Effect.succeed<JiraBreakdownStatus | null>("running")),
  );

  const start: JiraBreakdownService["Service"]["start"] = Effect.fn("JiraBreakdownService.start")(
    function* (userId, input) {
      yield* Effect.annotateCurrentSpan({ "jira.key": input.key });
      if (userId === undefined) return yield* signInRequired;
      yield* Effect.annotateCurrentSpan("jira.actingUserId", userId);
      const requested = normalizeJiraSite(input.site) ?? input.site;
      const identity = yield* credentials.identityFor(userId, requested);
      if (identity === undefined) return yield* personalTokenRequired;
      const site = identity.site;
      // Joining first: a press that would only join needs nothing from the project.
      const running = yield* runningBreakdown(site, input.key, input.projectId);
      if (running !== null) return { threadId: running, started: false };
      const launchSettings = yield* resolveLaunchSettings(input.projectId);
      // Read before the claim: Jira can be slow, and a second press must not wait on it.
      const context = yield* readContext(userId, identity, input.key);
      // Uninterruptible once claimed: a client hanging up must not leave a row without its thread.
      return yield* claims(`${site}\u0000${input.key}`)(
        Effect.gen(function* () {
          const joined = yield* runningBreakdown(site, input.key, input.projectId);
          if (joined !== null) return { threadId: joined, started: false };
          const workspace = yield* workspaceStrategy(launchSettings.workspaceRoot, input.key);
          const threadId = yield* ids.allocate
            .thread({ projectId: input.projectId })
            .pipe(Effect.catch(ledgerFailed));
          // Recorded before the launch, so the thread's first provider session already sees
          // it as a breakdown.
          yield* sql`
            INSERT INTO fork_jira_breakdowns (
              thread_id, site, issue_key, user_id, status, reason, created_at, finished_at
            ) VALUES (
              ${threadId}, ${site}, ${input.key}, ${userId}, 'running', NULL, ${yield* nowIso}, NULL
            )
          `.pipe(Effect.catch(ledgerFailed));
          yield* threadLaunch
            .launch({
              commandId: CommandId.make(`jira-breakdown:${site}:${input.key}:${threadId}`),
              threadId,
              projectId: input.projectId,
              title: truncate(
                oneLine(`Break down ${input.key}: ${context.issue.summary}`),
                TITLE_LIMIT,
              ),
              modelSelection: launchSettings.modelSelection,
              runtimeMode: launchSettings.runtimeMode,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              workspaceStrategy: workspace,
              initialMessage: { text: context.message, attachments: [] },
              // The user asked for it; the server wrote the message.
              createdBy: "user",
              creationSource: "server",
              createdByUserId: userId,
            })
            .pipe(
              Effect.catchTags({
                ThreadManagementProviderInstanceDisabledError: () =>
                  Effect.fail(
                    new JiraError({
                      reason: "invalid",
                      message:
                        "The project's default model is on a provider that is turned off. Turn it on or choose another default model, then try again.",
                    }),
                  ),
                ThreadLaunchError: (error) =>
                  Effect.logWarning("Could not launch a Jira breakdown thread", {
                    operation: error.operation,
                    cause: error.cause,
                  }).pipe(
                    Effect.andThen(
                      Effect.fail(unavailable("Could not start the breakdown thread.")),
                    ),
                  ),
              }),
              Effect.tapError(() =>
                finish(threadId, "failed", "The breakdown thread could not be started.").pipe(
                  Effect.ignore({ log: true }),
                ),
              ),
            );
          yield* orchestrator
            .dispatch({
              type: "thread.jira-issue.link",
              commandId: CommandId.make(`jira-breakdown:${threadId}:link`),
              threadId,
              site,
              key: input.key,
              source: "manual",
              linkedByUserId: userId,
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not link a Jira breakdown's issue to its thread", {
                  errorTag: error._tag,
                }),
              ),
            );
          yield* follower(threadId);
          return { threadId, started: true };
        }).pipe(Effect.uninterruptible),
      );
    },
  );

  // Breakdowns a previous process left running are followed again once the server is up.
  yield* ServerActivation.forkParked(
    sql`SELECT thread_id AS "threadId", status FROM fork_jira_breakdowns WHERE status = 'running'`.pipe(
      Effect.flatMap(decodeRows),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => follower(ThreadId.make(row.threadId)), { discard: true }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Could not resume following Jira breakdowns", { errorTag: error._tag }),
      ),
    ),
  );

  return JiraBreakdownService.of({ start, follow });
});

export const layer = Layer.effect(JiraBreakdownService, make);
