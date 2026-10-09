import {
  DiffWalkthrough,
  DiffWalkthroughError,
  type DiffWalkthroughThreadDiffTarget,
  type DiffWalkthroughTargetIdentity,
  type ProjectId,
  SourceControlProviderKind,
  diffWalkthroughTargetKey,
  pullRequestHostOf,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as DiffWalkthroughs from "../persistence/DiffWalkthroughs.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";

const decodeWalkthrough = Schema.decodeUnknownEffect(DiffWalkthrough);
const isSourceControlProviderKind = Schema.is(SourceControlProviderKind);

interface StoredChange {
  readonly key: string;
  readonly walkthrough: DiffWalkthrough;
}

/**
 * Agent-written walkthroughs of a diff, one per target. Agents write them, and every client
 * watching the same target sees the replacement as soon as it is stored.
 */
export class DiffWalkthroughService extends Context.Service<
  DiffWalkthroughService,
  {
    /** The stored walkthrough for the target's key, which may predate the target's revision. */
    readonly get: (
      target: DiffWalkthroughTargetIdentity,
    ) => Effect.Effect<DiffWalkthrough | null, DiffWalkthroughError>;
    /** Validates, stores, and announces a walkthrough, replacing any for the same key. */
    readonly put: (
      walkthrough: DiffWalkthrough,
    ) => Effect.Effect<DiffWalkthrough, DiffWalkthroughError>;
    /** The stored walkthrough, then every replacement of it. */
    readonly subscribe: (
      target: DiffWalkthroughTargetIdentity,
    ) => Stream.Stream<DiffWalkthrough | null, DiffWalkthroughError>;
  }
>()("t3/diffWalkthrough/DiffWalkthroughService") {}

const make = Effect.gen(function* () {
  const repository = yield* DiffWalkthroughs.DiffWalkthroughRepository;
  const projects = yield* ProjectService.ProjectService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const changes = yield* PubSub.unbounded<StoredChange>();
  // Store and announce in one step, so subscribers see replacements in the order they were stored.
  const writeLock = yield* Semaphore.make(1);

  /** The project's own pull request host, or null when it has no remote to tell it by. */
  const projectHostOf = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const project = yield* projects.getShell(projectId).pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );
      if (project === null) return null;
      const identity =
        project.repositoryIdentity ?? (yield* repositoryIdentities.resolve(project.workspaceRoot));
      const kind = identity?.provider;
      if (!identity || !isSourceControlProviderKind(kind)) return null;
      return pullRequestHostOf(identity, kind);
    });

  /**
   * A pull request without a host means the project's own, so it is filled in before keying:
   * otherwise a reference with and without the host would be two walkthroughs. A project whose
   * host cannot be told keeps the contract's project-scoped key.
   */
  const resolveTarget = <Target extends DiffWalkthroughTargetIdentity>(
    target: Target,
  ): Effect.Effect<Target> =>
    target.kind !== "pull-request" || target.host !== undefined
      ? Effect.succeed(target)
      : projectHostOf(target.projectId).pipe(
          Effect.map((host) => (host === null ? target : { ...target, host })),
        );

  const readByKey = (key: string) =>
    repository.getByKey(key).pipe(
      Effect.map(Option.getOrNull),
      Effect.mapError(
        (cause) => new DiffWalkthroughError({ message: "Could not read the walkthrough.", cause }),
      ),
    );

  const requireThread = (target: DiffWalkthroughThreadDiffTarget) =>
    orchestrator.getThreadShell(target.threadId).pipe(
      Effect.mapError(
        (cause) => new DiffWalkthroughError({ message: "Could not read the thread.", cause }),
      ),
      Effect.flatMap((thread) =>
        thread === null || thread.deletedAt !== null
          ? Effect.fail(new DiffWalkthroughError({ message: "The thread does not exist." }))
          : Effect.void,
      ),
    );

  const get: DiffWalkthroughService["Service"]["get"] = (target) =>
    resolveTarget(target).pipe(
      Effect.flatMap((resolved) => readByKey(diffWalkthroughTargetKey(resolved))),
    );

  const put: DiffWalkthroughService["Service"]["put"] = Effect.fn("DiffWalkthroughService.put")(
    function* (input) {
      const walkthrough = yield* decodeWalkthrough(input).pipe(
        Effect.mapError(
          (cause) => new DiffWalkthroughError({ message: "The walkthrough is invalid.", cause }),
        ),
      );
      const target = yield* resolveTarget(walkthrough.target);
      if (target.kind === "thread-diff") yield* requireThread(target);
      const stored: DiffWalkthrough = { ...walkthrough, target };
      const key = diffWalkthroughTargetKey(target);
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* writeLock.withPermits(1)(
        repository
          .upsert({
            key,
            kind: target.kind,
            threadId: target.kind === "thread-diff" ? target.threadId : null,
            walkthrough: stored,
            updatedAt,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new DiffWalkthroughError({ message: "Could not store the walkthrough.", cause }),
            ),
            Effect.andThen(PubSub.publish(changes, { key, walkthrough: stored })),
          ),
      );
      return stored;
    },
  );

  const subscribe: DiffWalkthroughService["Service"]["subscribe"] = (target) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const key = diffWalkthroughTargetKey(yield* resolveTarget(target));
        // Subscribe before reading, so a replacement stored in between is buffered, not lost.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(readByKey(key)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((change) => change.key === key),
            Stream.map((change): DiffWalkthrough | null => change.walkthrough),
          ),
        );
      }),
    );

  return DiffWalkthroughService.of({ get, put, subscribe });
});

export const layer = Layer.effect(DiffWalkthroughService, make);
