import {
  type DiffWalkthroughPullRequestTarget,
  type ProjectId,
  type PullRequestRef,
  type PullRequestSummary,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";

import * as DiffWalkthroughRunService from "../diffWalkthrough/DiffWalkthroughRunService.ts";
import * as DiffWalkthroughService from "../diffWalkthrough/DiffWalkthroughService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import type * as ProjectionStore from "./ProjectionStore.ts";

/**
 * How long a pull request's head has to stay put before its walkthrough is written. Sync reads
 * an open pull request once a minute, so this spans several reads: an agent pushing fix-ups for
 * failing checks, or a rebase and force-push, writes once for where the branch ends up.
 */
const QUIET_WINDOW = "5 minutes";

interface LinkEntry {
  readonly thread: ProjectionStore.ProjectionThreadPullRequests;
  readonly link: ThreadPullRequestLink;
}

/** One pull request at one head, waiting out the quiet window. */
interface Pending {
  readonly projectId: ProjectId;
  readonly reference: PullRequestRef;
  readonly headSha: string;
  readonly headBranch: string;
}

const isActive = (thread: ProjectionStore.ProjectionThreadPullRequests) =>
  thread.settledOverride !== "settled" &&
  thread.settledAt === null &&
  thread.lineage.relationshipToParent !== "subagent";

/**
 * The link whose thread's project a pull request's walkthrough is written in: the thread that
 * opened it, else the one that linked it first. A stack link names a sibling some other thread
 * owns.
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
 * Writes a linked pull request's walkthrough in the background when it is linked or its head
 * moves, in projects with `pullRequestAutoWalkthrough` on. Pull request sync reports each host
 * read here. A burst of pushes writes once, for the head that stays put for `QUIET_WINDOW`; what
 * is waiting, and the heads seen, live in memory, so a restart drops a pending run and its first
 * read of each pull request only learns the head.
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
    /** Waits until no run is waiting to start. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/PullRequestAutoWalkthrough") {}

const make = Effect.gen(function* () {
  const runs = yield* DiffWalkthroughRunService.DiffWalkthroughRunService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const walkthroughs = yield* DiffWalkthroughService.DiffWalkthroughService;
  const settings = yield* ServerSettings.ServerSettingsService;

  // The head and update time last read per pull request, so a read that saw nothing new costs
  // no detail read.
  const heads = new Map<string, { readonly headSha: string; readonly updatedAt: string }>();
  // The head each pending run is for; a newer head replaces it and restarts its wait.
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

  /** Checked again when the wait ends: the setting or a stored walkthrough may have changed. */
  const write = Effect.fn("PullRequestAutoWalkthrough.write")(
    function* (pending: Pending) {
      if (!(yield* enabledFor(pending.projectId))) return;
      const { reference, headSha } = pending;
      const target: DiffWalkthroughPullRequestTarget = {
        kind: "pull-request",
        projectId: pending.projectId,
        ...(reference.host === undefined ? {} : { host: reference.host }),
        repository: reference.repository,
        number: reference.number,
        headSha,
      };
      const stored = yield* walkthroughs.get(target);
      if (stored?.target.kind === "pull-request" && stored.target.headSha === headSha) return;
      // A walkthrough of the head branch at this head is what the PR panel shows in its place.
      const branch = yield* walkthroughs.get({
        kind: "branch-range",
        projectId: pending.projectId,
        branch: pending.headBranch,
      });
      if (branch?.target.kind === "branch-range" && branch.target.headSha === headSha) return;
      // Refused when no model here can investigate a checkout, or the head moved on; the next
      // push or link tries again.
      yield* runs.generate(target).pipe(
        Effect.catchTags({
          DiffWalkthroughError: (error) =>
            Effect.logInfo("automatic walkthrough not started", {
              number: reference.number,
              reason: error.message,
            }),
        }),
      );
    },
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("automatic walkthrough failed to start", { cause }),
    ),
  );

  const schedule = (key: string, target: Pending) =>
    Effect.gen(function* () {
      const headSha = target.headSha;
      if (pendingHeads.get(key) === headSha) return;
      pendingHeads.set(key, headSha);
      yield* FiberMap.run(
        pending,
        key,
        write(target).pipe(
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
        projectId: owner.thread.projectId,
        reference,
        headSha,
        headBranch: detail.headBranch,
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
