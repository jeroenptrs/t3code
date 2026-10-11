import {
  CommandId,
  ComposerContextId,
  MessageId,
  type OrchestrationV2Command,
  type ProjectId,
  type PullRequestDetail,
  type PullRequestRef,
  type PullRequestSummary,
  type ReviewCommentContextRecord,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  PULL_REQUEST_WALKTHROUGH_REQUEST,
  boundedPullRequestField,
  pullRequestContextLines,
  pullRequestWalkthroughInstructions,
} from "@t3tools/shared/pullRequestWalkthroughPrompt";
import {
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";

import * as DiffWalkthroughService from "../diffWalkthrough/DiffWalkthroughService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/**
 * How long a pull request's head has to stay put before its walkthrough is asked for. Sync reads
 * an open pull request once a minute, so this spans several reads: an agent pushing fix-ups for
 * failing checks, or a rebase and force-push, asks once for where the branch ends up.
 */
const QUIET_WINDOW = "5 minutes";

interface LinkEntry {
  readonly thread: ProjectionStore.ProjectionThreadPullRequests;
  readonly link: ThreadPullRequestLink;
}

/** One pull request at one head, waiting out the quiet window. */
interface Pending {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly reference: PullRequestRef;
  readonly link: ThreadPullRequestLink;
  readonly detail: PullRequestDetail & { readonly headSha: string };
}

const isActive = (thread: ProjectionStore.ProjectionThreadPullRequests) =>
  thread.settledOverride !== "settled" &&
  thread.settledAt === null &&
  thread.lineage.relationshipToParent !== "subagent";

/**
 * The thread a pull request's walkthrough goes to: the one that opened it, else the one that
 * linked it first. A stack link names a sibling some other thread owns.
 */
function ownerOf(entries: ReadonlyArray<LinkEntry>): LinkEntry | undefined {
  return entries
    .filter(({ thread, link }) => link.source !== "stack" && isActive(thread))
    .toSorted(
      (left, right) =>
        Number(right.link.source === "created") - Number(left.link.source === "created") ||
        left.link.linkedAt.localeCompare(right.link.linkedAt),
    )[0];
}

/**
 * The message the PR panel's Generate button leaves in the composer, sent: the request, and the
 * pull request chip carrying how to write it.
 */
function walkthroughRequest(
  pending: Pending,
): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> {
  const { detail } = pending;
  const contextId = ComposerContextId.make(`review-comment_pull-request-context-${detail.number}`);
  const label = `#${detail.number}`;
  const chip: ReviewCommentContextRecord = {
    version: 1,
    contextId,
    kind: "review-comment",
    label,
    sectionId: `pull-request:${detail.number}`,
    sectionTitle: `PR #${detail.number}`,
    filePath: `PR #${detail.number}`,
    startIndex: 0,
    endIndex: 0,
    rangeLabel: boundedPullRequestField(detail.title),
    text: [...pullRequestContextLines(detail), ...pullRequestWalkthroughInstructions(detail)].join(
      "\n",
    ),
    diff: "",
    pullRequest: {
      number: detail.number,
      title: boundedPullRequestField(detail.title),
      url: boundedPullRequestField(detail.url),
      headBranch: boundedPullRequestField(detail.headBranch),
      baseBranch: boundedPullRequestField(detail.baseBranch),
      state: detail.state,
      isDraft: detail.isDraft,
    },
  };
  // One ask per thread and head: a repeat of the same command replays its receipt.
  const identity = `${pending.threadId}:${detail.number}:${detail.headSha}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`server:pr-walkthrough:${identity}`),
    messageId: MessageId.make(`message:pr-walkthrough:${identity}`),
    threadId: pending.threadId,
    text: `${PULL_REQUEST_WALKTHROUGH_REQUEST} ${formatComposerContextReference({ kind: "review-comment", contextId, label })}`,
    context: { version: 1, records: [chip] },
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "user",
    creationSource: "server",
  };
}

/**
 * Asks the thread that owns a pull request for a walkthrough when the pull request is linked or
 * its head moves, in projects with `pullRequestAutoWalkthrough` on. Pull request sync reports
 * each host read here. A burst of pushes asks once, for the head that stays put for
 * `QUIET_WINDOW`; what is waiting, and the heads seen, live in memory, so a restart drops a
 * pending ask and its first read of each pull request only learns the head.
 */
export class PullRequestAutoWalkthrough extends Context.Service<
  PullRequestAutoWalkthrough,
  {
    /** What one sync read saw of a pull request, with every visible link that holds it. */
    readonly observe: (input: {
      readonly key: string;
      readonly reference: PullRequestRef;
      readonly summary: PullRequestSummary;
      readonly entries: ReadonlyArray<LinkEntry>;
    }) => Effect.Effect<void>;
    /** Waits until no ask is pending. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/PullRequestAutoWalkthrough") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const walkthroughs = yield* DiffWalkthroughService.DiffWalkthroughService;
  const settings = yield* ServerSettings.ServerSettingsService;

  // The head and update time last read per pull request, so a read that saw nothing new costs
  // no detail read.
  const heads = new Map<string, { readonly headSha: string; readonly updatedAt: string }>();
  // The head each pending ask is for; a newer head replaces the ask and restarts its wait.
  const pendingHeads = new Map<string, string>();
  const pending = yield* FiberMap.make<string, void, never>();

  const enabledFor = (projectId: ProjectId) =>
    settings.getSettings.pipe(
      Effect.map(
        (current) => resolveProjectSettings(current, projectId).settings.pullRequestAutoWalkthrough,
      ),
      Effect.catch((error) =>
        Effect.logWarning("automatic walkthrough could not read settings", { error }).pipe(
          Effect.as(false),
        ),
      ),
    );

  /** Checked again when the wait ends: the setting, the link, or a walkthrough may have changed. */
  const ask = Effect.fn("PullRequestAutoWalkthrough.ask")(
    function* (target: Pending) {
      if (!(yield* enabledFor(target.projectId))) return;
      const threads = yield* projections.getThreadsWithPullRequests(target.threadId);
      const thread = threads.find((candidate) => candidate.id === target.threadId);
      const linked =
        thread !== undefined &&
        isActive(thread) &&
        visibleThreadPullRequests(thread.pullRequests ?? []).some((link) =>
          threadPullRequestKeysEqual(link, target.link),
        );
      if (!linked) return;
      const stored = yield* walkthroughs.get({
        kind: "pull-request",
        projectId: target.projectId,
        ...(target.reference.host === undefined ? {} : { host: target.reference.host }),
        repository: target.reference.repository,
        number: target.reference.number,
      });
      if (stored?.target.kind === "pull-request" && stored.target.headSha === target.detail.headSha)
        return;
      // A walkthrough of the head branch at this head is what the PR panel shows in its place.
      const branch = yield* walkthroughs.get({
        kind: "branch-range",
        projectId: target.projectId,
        branch: target.detail.headBranch,
      });
      if (branch?.target.kind === "branch-range" && branch.target.headSha === target.detail.headSha)
        return;
      yield* engine.dispatch(walkthroughRequest(target));
    },
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("automatic walkthrough request failed", { cause }),
    ),
  );

  const schedule = (key: string, target: Pending) =>
    Effect.gen(function* () {
      const headSha = target.detail.headSha;
      if (pendingHeads.get(key) === headSha) return;
      pendingHeads.set(key, headSha);
      yield* FiberMap.run(
        pending,
        key,
        ask(target).pipe(
          Effect.delay(QUIET_WINDOW),
          Effect.ensuring(
            Effect.sync(() => {
              if (pendingHeads.get(key) === headSha) pendingHeads.delete(key);
            }),
          ),
        ),
      );
    });

  const forget = (key: string) =>
    Effect.suspend(() => {
      heads.delete(key);
      return FiberMap.remove(pending, key);
    });

  const observe: PullRequestAutoWalkthrough["Service"]["observe"] = Effect.fn(
    "PullRequestAutoWalkthrough.observe",
  )(
    function* ({ key, reference, summary, entries }) {
      // Merged and closed pull requests are past reviewing; one that reopens starts over.
      const owner = summary.state === "open" ? ownerOf(entries) : undefined;
      if (owner === undefined || !(yield* enabledFor(owner.thread.projectId))) {
        return yield* forget(key);
      }
      const linked = owner.link.snapshot === null;
      const last = heads.get(key);
      if (!linked && last?.updatedAt === summary.updatedAt) return;
      // A push moves the update time; the cached detail may predate it.
      yield* pullRequests.invalidate({ reference });
      const detail = yield* pullRequests.detail(reference);
      const headSha = detail.headSha;
      if (headSha === undefined || detail.state !== "open") return;
      heads.set(key, { headSha, updatedAt: summary.updatedAt });
      // The first read after a restart only learns the head.
      if (!linked && (last === undefined || last.headSha === headSha)) return;
      yield* schedule(key, {
        threadId: owner.thread.id,
        projectId: owner.thread.projectId,
        reference,
        link: owner.link,
        detail: { ...detail, headSha },
      });
    },
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("automatic walkthrough check failed", { cause }),
    ),
  );

  return PullRequestAutoWalkthrough.of({ observe, drain: FiberMap.awaitEmpty(pending) });
});

export const layer = Layer.effect(PullRequestAutoWalkthrough, make);
