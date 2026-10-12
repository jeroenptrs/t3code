/**
 * Walkthroughs the server writes itself, in the background, on the environment's guide and
 * walkthrough model. The model reads the diff read-only from a disposable checkout of its head,
 * so a run takes minutes on a large change and belongs to the server rather than to the request
 * that started it: `generate` returns once the run is under way, and readers follow its state
 * through `subscribe` beside the stored walkthrough.
 *
 * Mirrors `PullRequestReviewGuideService.generate`'s claim and ownership, per walkthrough key
 * rather than per pull request.
 *
 * @module diffWalkthrough/DiffWalkthroughRunService
 */
import {
  DiffWalkthrough,
  DiffWalkthroughError,
  type DiffWalkthroughBranchRangeTarget,
  type DiffWalkthroughGenerateResult,
  type DiffWalkthroughGetResult,
  type DiffWalkthroughPullRequestTarget,
  type DiffWalkthroughRun,
  type DiffWalkthroughRunning,
  type DiffWalkthroughTarget,
  type DiffWalkthroughTargetIdentity,
  type DiffWalkthroughThreadDiffTarget,
  type ModelSelection,
  type OrchestrationProjectShell,
  ProjectId,
  type PullRequestDetail,
  type PullRequestRef,
  isDiffWalkthroughStale,
} from "@t3tools/contracts";
import type { DiffWalkthroughGenerationResult } from "@t3tools/provider-core/server/textGeneration";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { pullRequestSyncKey } from "../pullRequest/pullRequestSyncKey.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as DiffWalkthroughService from "./DiffWalkthroughService.ts";
import * as DiffWalkthroughWriter from "./DiffWalkthroughWriter.ts";

export class DiffWalkthroughRunService extends Context.Service<
  DiffWalkthroughRunService,
  {
    /**
     * Start writing a walkthrough of the target's revision and return once it is under way. Joins
     * a run already going for that revision, and replaces one going for another. A stored
     * walkthrough stays readable until the new one replaces it. `started` says whether this call
     * began the run or joined one. Auto-generation calls this directly.
     *
     * Fails without starting a run when the target is unusable or the guide and walkthrough model
     * cannot investigate a checkout, with the reason the subscription reports as `unavailable`.
     */
    readonly generate: (
      target: DiffWalkthroughTarget,
    ) => Effect.Effect<DiffWalkthroughGenerateResult, DiffWalkthroughError>;
    /**
     * The stored walkthrough, the target's run, and why a run cannot start now, then all three
     * again whenever one changes. `unavailable` follows the server's settings and providers.
     */
    readonly subscribe: (
      target: DiffWalkthroughTargetIdentity,
    ) => Stream.Stream<DiffWalkthroughGetResult, DiffWalkthroughError>;
  }
>()("t3/diffWalkthrough/DiffWalkthroughRunService") {}

const decodeWalkthrough = Schema.decodeUnknownEffect(DiffWalkthrough);
const isDiffWalkthroughError = Schema.is(DiffWalkthroughError);

/** Logged when a run finishes after a newer revision's run took its key. */
export const DROPPED_SUPERSEDED_RUN = "Dropped a walkthrough written for a superseded revision";

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis))),
);

/** Where a host serves a pull request's head when it will not serve the commit by itself. */
function pullRequestHeadRef(provider: string | undefined, number: number): string | null {
  switch (provider) {
    case "github":
    case "forgejo":
      return `refs/pull/${number}/head`;
    case "gitlab":
      return `refs/merge-requests/${number}/head`;
    default:
      return null;
  }
}

const pullRequestRefOf = (target: DiffWalkthroughPullRequestTarget): PullRequestRef => ({
  projectId: target.projectId,
  ...(target.host === undefined ? {} : { host: target.host }),
  repository: target.repository,
  number: target.number,
});

/** What a run reads from, settled before it is claimed so a bad target fails the request. */
type Prepared =
  | {
      readonly kind: "pull-request";
      readonly target: DiffWalkthroughPullRequestTarget;
      readonly project: OrchestrationProjectShell;
      readonly detail: PullRequestDetail;
    }
  | {
      readonly kind: "branch-range";
      readonly target: DiffWalkthroughBranchRangeTarget;
      readonly project: OrchestrationProjectShell;
    }
  | {
      readonly kind: "thread-diff";
      readonly target: DiffWalkthroughThreadDiffTarget;
      readonly projectId: ProjectId;
      readonly title: string;
      readonly range: CheckpointDiffQuery.CheckpointTurnRange;
    };

interface Checkout {
  readonly path: string;
  readonly baseCommit: string;
}

/** The message a reader sees for an error; the full cause goes to the log. */
function messageOf(error: unknown): string | null {
  if (isDiffWalkthroughError(error)) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "detail" in error &&
    typeof error.detail === "string" &&
    error.detail.trim().length > 0
  ) {
    return error.detail;
  }
  return null;
}

const failureDetail = (cause: Cause.Cause<unknown>): string =>
  messageOf(Cause.squash(cause)) ?? "The walkthrough could not be written.";

const make = Effect.gen(function* () {
  const walkthroughs = yield* DiffWalkthroughService.DiffWalkthroughService;
  const writer = yield* DiffWalkthroughWriter.DiffWalkthroughWriter;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const projects = yield* ProjectService.ProjectService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const checkpointDiffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  // Runs outlive the request that started them and end with the server.
  const serviceScope = yield* Effect.scope;
  // In memory on purpose: a restart drops a run in progress, and a reader starts it again.
  const runs = yield* SubscriptionRef.make<ReadonlyMap<string, DiffWalkthroughRun>>(new Map());
  // Names each run's private git refs; unique for the server's lifetime, like the runs map.
  let runCounter = 0;
  // Claiming a run and storing a finished walkthrough take turns, so a run that still owns its
  // key when it checks is the one whose walkthrough is stored: a newer claim cannot land between.
  const ownership = yield* Semaphore.make(1);

  /** An error a reader can act on: what failed, then the underlying reason when there is one. */
  const fail = (message: string) => (cause: unknown) => {
    const reason = messageOf(cause);
    return new DiffWalkthroughError({
      message: reason === null ? message : `${message} ${reason}`,
      cause,
    });
  };

  const requireProject = (projectId: ProjectId) =>
    projects.getShell(projectId).pipe(
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
      Effect.filterOrFail(
        (project) => project !== null,
        () => new DiffWalkthroughError({ message: "The project does not exist." }),
      ),
    );

  /**
   * The checkout is fetched from the project's own remote, so the pull request has to be in that
   * repository. One from another repository is refused rather than measured against commits that
   * are not its own.
   */
  const requireOwnRepository = (
    target: DiffWalkthroughPullRequestTarget,
    project: OrchestrationProjectShell,
  ) => {
    const identity = project.repositoryIdentity;
    const key = pullRequestSyncKey(pullRequestRefOf(target), identity ?? undefined);
    const own =
      identity == null
        ? null
        : pullRequestSyncKey(
            {
              projectId: ProjectId.make("own"),
              number: target.number,
              repository: sourceControlRepositorySelector(identity) ?? "",
            },
            identity,
          );
    return key !== null &&
      own !== null &&
      own.host === key.host &&
      own.repository === key.repository
      ? Effect.void
      : Effect.fail(
          new DiffWalkthroughError({
            message:
              "Walkthroughs are written from this project's checkout, and this pull request is in another repository. Write it from a project that is a checkout of that repository.",
          }),
        );
  };

  const readPullRequest = (target: DiffWalkthroughPullRequestTarget) =>
    pullRequests
      .detail(pullRequestRefOf(target))
      .pipe(Effect.mapError(fail("Could not read the pull request.")));

  const requireCommit = (cwd: string, revision: string) =>
    git.resolveCommit({ cwd, revision }).pipe(
      Effect.mapError(
        (cause) =>
          new DiffWalkthroughError({
            message: `Commit ${revision} is not in this project's repository.`,
            cause,
          }),
      ),
    );

  const prepare = Effect.fn("DiffWalkthroughRunService.prepare")(function* (
    target: DiffWalkthroughTarget,
  ) {
    switch (target.kind) {
      case "pull-request": {
        const project = yield* requireProject(target.projectId);
        yield* requireOwnRepository(target, project);
        // A press asks for the head as it is now, not a read shared from the last minute, so a
        // walkthrough is never started for a commit the pull request has already moved past.
        yield* pullRequests.invalidate({ reference: pullRequestRefOf(target) });
        const detail = yield* readPullRequest(target);
        if ((detail.headSha ?? null) !== target.headSha) {
          return yield* new DiffWalkthroughError({
            message: "The pull request has moved to another head. Reload it and try again.",
          });
        }
        return { kind: "pull-request", target, project, detail } satisfies Prepared;
      }
      case "branch-range": {
        const project = yield* requireProject(target.projectId);
        yield* requireCommit(project.workspaceRoot, target.baseSha);
        yield* requireCommit(project.workspaceRoot, target.headSha);
        return { kind: "branch-range", target, project } satisfies Prepared;
      }
      case "thread-diff": {
        const thread = yield* orchestrator
          .getThreadShell(target.threadId)
          .pipe(Effect.mapError(fail("Could not read the thread.")));
        if (thread === null || thread.deletedAt !== null) {
          return yield* new DiffWalkthroughError({ message: "The thread does not exist." });
        }
        if (target.fromTurnCount >= target.toTurnCount) {
          return yield* new DiffWalkthroughError({
            message: "There is no change to walk through.",
          });
        }
        const range = yield* checkpointDiffs
          .resolveTurnRange(target)
          .pipe(Effect.mapError(fail("Those turns' checkpoints are not available.")));
        return {
          kind: "thread-diff",
          target,
          projectId: thread.projectId,
          title: thread.title,
          range,
        } satisfies Prepared;
      }
    }
  });

  /**
   * A detached checkout of `revision`, beside the project and removed when the run's scope
   * closes, whether it succeeded, failed, or was interrupted. Never the live checkout.
   */
  const addWorktree = Effect.fn("DiffWalkthroughRunService.addWorktree")(function* (
    repository: string,
    revision: string,
  ) {
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      directory: config.worktreesDir,
      prefix: "diff-walkthrough-",
    });
    const path = `${directory}/checkout`;
    yield* git.execute({
      operation: "DiffWalkthroughRunService.addWorktree",
      cwd: repository,
      args: ["worktree", "add", "--detach", "--quiet", path, revision],
      timeoutMs: 5 * 60_000,
    });
    yield* Effect.addFinalizer(() =>
      git.removeWorktree({ cwd: repository, path, force: true }).pipe(Effect.ignore({ log: true })),
    );
    return path;
  });

  /**
   * A pull request's head, fetched by commit so a fork's head works and the checkout is exactly
   * what the host reported, then measured from where it left its base branch.
   */
  const checkoutPullRequest = Effect.fn("DiffWalkthroughRunService.checkoutPullRequest")(function* (
    prepared: Extract<Prepared, { kind: "pull-request" }>,
    runId: string,
  ) {
    const { detail, project, target } = prepared;
    const workspaceRoot = project.workspaceRoot;
    const remote = yield* git.resolvePrimaryRemoteName(workspaceRoot);
    const fetch = (args: ReadonlyArray<string>) =>
      git.execute({
        operation: "DiffWalkthroughRunService.fetch",
        cwd: workspaceRoot,
        args: ["fetch", "--quiet", "--no-tags", remote, ...args],
        timeoutMs: 5 * 60_000,
      });
    // The host names the base branch. A name git rejects, or one that would change the refspec
    // (a leading `+`, a `:`), is refused before it reaches `git fetch`.
    const baseBranch = detail.baseBranch;
    const baseBranchFetchable = yield* git
      .execute({
        operation: "DiffWalkthroughRunService.checkBaseBranch",
        cwd: workspaceRoot,
        args: ["check-ref-format", "--branch", baseBranch],
      })
      .pipe(
        Effect.as(!baseBranch.startsWith("+") && !baseBranch.includes(":")),
        Effect.orElseSucceed(() => false),
      );
    if (!baseBranchFetchable) {
      return yield* new DiffWalkthroughError({
        message: "The pull request's base branch name is not one git can fetch.",
      });
    }
    // Fetched into a ref of this run's own: FETCH_HEAD is shared by every fetch in the
    // workspace, so a concurrent run could otherwise measure this change from its base.
    const baseRef = `refs/t3/diff-walkthrough/${runId}/base`;
    yield* fetch([`+refs/heads/${baseBranch}:${baseRef}`]).pipe(
      Effect.mapError(fail(`Could not fetch the base branch ${baseBranch}.`)),
    );
    yield* Effect.addFinalizer(() =>
      git
        .execute({
          operation: "DiffWalkthroughRunService.dropBaseRef",
          cwd: workspaceRoot,
          args: ["update-ref", "-d", baseRef],
        })
        .pipe(Effect.ignore({ log: true })),
    );
    const baseTip = yield* git.resolveCommit({ cwd: workspaceRoot, revision: baseRef });
    // Hosts that do not serve an unadvertised commit still serve their pull request refs.
    const headRef = pullRequestHeadRef(project.repositoryIdentity?.provider, target.number);
    yield* fetch([target.headSha]).pipe(
      Effect.catch((cause) => (headRef === null ? Effect.fail(cause) : fetch([headRef]))),
      Effect.mapError(fail("Could not fetch the pull request's head.")),
    );
    const path = yield* addWorktree(workspaceRoot, target.headSha);
    const mergeBase = yield* git.execute({
      operation: "DiffWalkthroughRunService.mergeBase",
      cwd: path,
      args: ["merge-base", baseTip.commitSha, "HEAD"],
    });
    return { path, baseCommit: mergeBase.stdout.trim() } satisfies Checkout;
  });

  /** Branch ranges and checkpoint pairs are local commits; nothing is fetched. */
  const checkout = (prepared: Prepared, runId: string) => {
    switch (prepared.kind) {
      case "pull-request":
        return checkoutPullRequest(prepared, runId);
      case "branch-range":
        return addWorktree(prepared.project.workspaceRoot, prepared.target.headSha).pipe(
          Effect.map((path): Checkout => ({ path, baseCommit: prepared.target.baseSha })),
        );
      case "thread-diff":
        return Effect.gen(function* () {
          const { cwd, fromCheckpointRef, toCheckpointRef } = prepared.range;
          const base = yield* git.resolveCommit({ cwd, revision: fromCheckpointRef });
          const head = yield* git.resolveCommit({ cwd, revision: toCheckpointRef });
          const path = yield* addWorktree(cwd, head.commitSha);
          return { path, baseCommit: base.commitSha } satisfies Checkout;
        });
    }
  };

  const describe = (prepared: Prepared) => {
    switch (prepared.kind) {
      case "pull-request":
        return {
          subject: `pull request #${prepared.target.number}, "${prepared.detail.title}"`,
          description: prepared.detail.body ?? "",
          hasCommitHistory: true,
        };
      case "branch-range":
        return {
          subject: `the branch \`${prepared.target.branch}\``,
          description: "",
          hasCommitHistory: true,
        };
      case "thread-diff": {
        const { fromTurnCount, toTurnCount } = prepared.target;
        const turns =
          toTurnCount - fromTurnCount === 1
            ? `turn ${toTurnCount}`
            : `turns ${fromTurnCount + 1} to ${toTurnCount}`;
        return {
          subject: `the changes a coding agent made in ${turns} of its thread "${prepared.title}"`,
          description: "",
          // Checkpoints are snapshots, not a history of the agent's commits.
          hasCommitHistory: false,
        };
      }
    }
  };

  const projectIdOf = (prepared: Prepared) =>
    prepared.kind === "thread-diff" ? prepared.projectId : prepared.target.projectId;

  /**
   * The guide and walkthrough model and instructions, with why that model cannot write a
   * walkthrough when it cannot.
   */
  const readModel = Effect.fn("DiffWalkthroughRunService.readModel")(function* (
    projectId: ProjectId | null,
  ) {
    const [settings, providers] = yield* Effect.all(
      [
        serverSettings.getSettings.pipe(
          Effect.mapError(fail("Could not read the server's settings.")),
        ),
        providerRegistry.getProviders,
      ],
      { concurrency: "unbounded" },
    );
    const projectSettings = resolveProjectSettings(settings, projectId).settings;
    const modelSelection = ServerSettings.resolveReviewGuideModelSelection(
      projectSettings,
      providers,
      projectId,
    );
    return {
      modelSelection,
      instructions: projectSettings.reviewGuideInstructions,
      refusal: yield* textGeneration.investigationRefusal(modelSelection),
    };
  });

  type Model = Effect.Success<ReturnType<typeof readModel>>;

  /** The written walkthrough, held to the contract with the envelope the server fills in. */
  const complete = (
    target: DiffWalkthroughTarget,
    generated: DiffWalkthroughGenerationResult,
    modelSelection: ModelSelection,
  ) =>
    nowIso.pipe(
      Effect.flatMap((generatedAt) =>
        decodeWalkthrough({
          ...generated,
          target,
          generatedAt,
          author: { provider: modelSelection.instanceId, model: modelSelection.model },
        }),
      ),
      Effect.mapError(
        (cause) =>
          new DiffWalkthroughError({
            message: `The model wrote an invalid walkthrough: ${cause.message.slice(0, 1_000)}`,
            cause,
          }),
      ),
    );

  const write = Effect.fn("DiffWalkthroughRunService.write")(function* (
    prepared: Prepared,
    { modelSelection, instructions }: Model,
    runId: string,
    owns: Effect.Effect<boolean>,
  ) {
    // The checkout lives only as long as the model is reading it.
    const generated = yield* checkout(prepared, runId).pipe(
      Effect.flatMap(({ path, baseCommit }) =>
        git
          .execute({
            operation: "DiffWalkthroughRunService.stat",
            cwd: path,
            args: ["-c", "core.quotePath=false", "diff", "--stat=200", baseCommit, "HEAD"],
            timeoutMs: 60_000,
            maxOutputBytes: 8 * 1024 * 1024,
          })
          .pipe(
            Effect.flatMap(({ stdout }) =>
              textGeneration.generateDiffWalkthrough({
                cwd: path,
                ...describe(prepared),
                baseCommit,
                stat: stdout,
                instructions,
                modelSelection,
              }),
            ),
          ),
      ),
      Effect.scoped,
    );
    const completed = yield* complete(prepared.target, generated, modelSelection);
    // Held before the lock: it reads the change from git or the host, and other claims must not
    // wait on that.
    const { walkthrough, held } = yield* writer.hold(completed);
    if (!held.clamped || held.dropped.length > 0 || held.narrowed.length > 0) {
      yield* Effect.logInfo("Held a background walkthrough's notes to its change", {
        clamped: held.clamped,
        reason: held.reason,
        dropped: held.dropped.length,
        narrowed: held.narrowed.length,
      });
    }
    // A newer run for this key, say after a push, owns its walkthrough now; this one's result is
    // for an older revision and is dropped rather than written over it.
    yield* ownership.withPermits(1)(
      Effect.gen(function* () {
        if (yield* owns) yield* walkthroughs.put(walkthrough);
        else yield* Effect.logInfo(DROPPED_SUPERSEDED_RUN);
      }),
    );
  });

  const generate: DiffWalkthroughRunService["Service"]["generate"] = Effect.fn(
    "DiffWalkthroughRunService.generate",
  )(function* (target) {
    const prepared = yield* prepare(target);
    // Refused before anything is claimed or checked out: no run could succeed on this model.
    const model = yield* readModel(projectIdOf(prepared));
    if (model.refusal !== null) {
      return yield* new DiffWalkthroughError({ message: model.refusal });
    }
    const runKey = yield* walkthroughs.keyOf(target);
    const running: DiffWalkthroughRunning = {
      _tag: "Running",
      target,
      startedAt: yield* nowIso,
    };
    // Claimed atomically, so two presses start one run between them. A pull request's head is
    // read again under the claim: a press that read an older head before a push must not replace
    // a run another press started for the new one, so it asks to be pressed again.
    const recheck =
      prepared.kind === "pull-request"
        ? readPullRequest(prepared.target).pipe(
            Effect.filterOrFail(
              (latest) => (latest.headSha ?? null) === prepared.target.headSha,
              () =>
                new DiffWalkthroughError({
                  message:
                    "The pull request changed while the walkthrough was starting. Try again.",
                }),
            ),
          )
        : Effect.void;
    const claimed = yield* ownership.withPermits(1)(
      recheck.pipe(
        Effect.andThen(
          SubscriptionRef.modify(runs, (current) => {
            const existing = current.get(runKey);
            if (
              existing?._tag === "Running" &&
              !isDiffWalkthroughStale({ target: existing.target }, target)
            ) {
              return [existing, current] as const;
            }
            return [running, new Map(current).set(runKey, running)] as const;
          }),
        ),
      ),
    );
    if (claimed !== running) return { run: claimed as DiffWalkthroughRunning, started: false };

    // The run is identified by its own Running value: a later claim replaces it, and from then
    // on this run's completion leaves the newer run's state and walkthrough alone.
    const owns = SubscriptionRef.get(runs).pipe(
      Effect.map((current) => current.get(runKey) === running),
    );
    const finish = (next: DiffWalkthroughRun | null) =>
      SubscriptionRef.update(runs, (current) => {
        if (current.get(runKey) !== running) return current;
        const updated = new Map(current);
        if (next === null) updated.delete(runKey);
        else updated.set(runKey, next);
        return updated;
      });
    const runId = `${runCounter++}`;
    yield* write(prepared, model, runId, owns).pipe(
      Effect.andThen(finish(null)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? finish(null)
          : Effect.logWarning("Diff walkthrough generation failed", {
              key: runKey,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.andThen(nowIso),
              Effect.flatMap((failedAt) =>
                finish({ _tag: "Failed", target, failedAt, detail: failureDetail(cause) }),
              ),
            ),
      ),
      Effect.forkIn(serviceScope),
    );
    return { run: running, started: true };
  });

  /** The project whose settings a target's runs use; a missing thread falls back to none. */
  const projectIdOfIdentity = (target: DiffWalkthroughTargetIdentity) =>
    target.kind === "thread-diff"
      ? orchestrator.getThreadShell(target.threadId).pipe(
          Effect.map((thread) => (thread === null ? null : thread.projectId)),
          Effect.orElseSucceed(() => null),
        )
      : Effect.succeed(target.projectId);

  /** Why a run cannot start, read again whenever settings or providers change. */
  const unavailableChanges = (target: DiffWalkthroughTargetIdentity) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribed before the first read, so a change made in between is not missed.
        const settingsChanges = yield* serverSettings.subscribeChanges;
        const projectId = yield* projectIdOfIdentity(target);
        return Stream.concat(
          Stream.succeed(undefined),
          Stream.merge(settingsChanges, providerRegistry.streamChanges),
        ).pipe(
          Stream.mapEffect(() => readModel(projectId)),
          Stream.map(({ refusal }) => refusal),
          Stream.changes,
        );
      }),
    );

  const subscribe: DiffWalkthroughRunService["Service"]["subscribe"] = (target) =>
    Stream.unwrap(
      walkthroughs.keyOf(target).pipe(
        Effect.map((key) =>
          Stream.zipLatestAll(
            walkthroughs.subscribe(target),
            SubscriptionRef.changes(runs).pipe(
              Stream.map((current) => current.get(key) ?? null),
              // Another key's run changing is not news to this reader.
              Stream.changesWith((left, right) => left === right),
            ),
            unavailableChanges(target),
          ).pipe(
            Stream.map(([walkthrough, run, unavailable]): DiffWalkthroughGetResult => ({
              walkthrough,
              run,
              unavailable,
            })),
          ),
        ),
      ),
    );

  return DiffWalkthroughRunService.of({ generate, subscribe });
});

export const layer = Layer.effect(DiffWalkthroughRunService, make);
