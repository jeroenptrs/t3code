import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointRef,
  type DiffWalkthroughBranchRangeTarget,
  type DiffWalkthroughGetResult,
  type DiffWalkthroughPullRequestTarget,
  type DiffWalkthroughTarget,
  type DiffWalkthroughTargetIdentity,
  type DiffWalkthroughThreadDiffTarget,
  type ModelSelection,
  type OrchestrationProjectShell,
  ProjectId,
  ProviderInstanceId,
  type PullRequestDetail,
  PullRequestOperationError,
  type ServerSettings as ServerSettingsValue,
  ThreadId,
} from "@t3tools/contracts";
import type {
  DiffWalkthroughGenerationInput,
  DiffWalkthroughGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";
import { investigationUnsupported } from "@t3tools/provider-core/server/textGenerationOperations";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { v2PullRequestThread } from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as DiffWalkthroughs from "../persistence/DiffWalkthroughs.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as DiffWalkthroughChangeReader from "./DiffWalkthroughChangeReader.ts";
import * as DiffWalkthroughRunService from "./DiffWalkthroughRunService.ts";
import * as DiffWalkthroughService from "./DiffWalkthroughService.ts";
import * as DiffWalkthroughWriter from "./DiffWalkthroughWriter.ts";

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 });
    return result.stdout.trim();
  });

/**
 * A remote whose `main` moved on after `feature` left it, cloned into the project's workspace.
 * `feature` has two commits, so a pull request can move from the first head to the second.
 */
const makeRepositories = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-walkthrough-run-" });
  const remote = `${root}/remote`;
  const workspace = `${root}/workspace`;
  yield* fs.makeDirectory(remote);
  yield* git(remote, ["init", "--quiet", "--initial-branch=main"]);
  yield* git(remote, ["config", "user.email", "test@example.com"]);
  yield* git(remote, ["config", "user.name", "Test"]);
  const commit = (path: string, message: string) =>
    fs
      .writeFileString(`${remote}/${path}`, `${message}\n`)
      .pipe(
        Effect.andThen(git(remote, ["add", path])),
        Effect.andThen(git(remote, ["commit", "--quiet", "-m", message])),
        Effect.andThen(git(remote, ["rev-parse", "HEAD"])),
      );
  const baseSha = yield* commit("base.txt", "base");
  yield* git(remote, ["checkout", "--quiet", "-b", "feature"]);
  const headSha = yield* commit("feature.txt", "the change");
  yield* git(remote, ["checkout", "--quiet", "-b", "pushed"]);
  const newerHeadSha = yield* commit("more.txt", "a later push");
  yield* git(remote, ["checkout", "--quiet", "main"]);
  yield* commit("unrelated.txt", "main moved on");
  yield* git(root, ["clone", "--quiet", remote, workspace]);
  return { root, workspace, baseSha, headSha, newerHeadSha };
});
type Repositories = Effect.Success<typeof makeRepositories>;

const ACME_APP = {
  canonicalKey: "github.com/acme/app",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/acme/app.git",
  },
  provider: "github",
  displayName: "acme/app",
  owner: "acme",
  name: "app",
};

const pullRequestTarget = (headSha: string): DiffWalkthroughPullRequestTarget => ({
  kind: "pull-request",
  projectId,
  host: "github.com",
  repository: "acme/app",
  number: 7,
  headSha,
});

const branchTarget = (repositories: Repositories): DiffWalkthroughBranchRangeTarget => ({
  kind: "branch-range",
  projectId,
  branch: "feature",
  baseSha: repositories.baseSha,
  headSha: repositories.headSha,
});

const threadTarget: DiffWalkthroughThreadDiffTarget = {
  kind: "thread-diff",
  threadId,
  fromTurnCount: 1,
  toTurnCount: 2,
};

/** A walkthrough as a model writes it, which the contract accepts. */
const answer = (summary: string): DiffWalkthroughGenerationResult => ({
  summary,
  groups: [
    {
      id: "feature",
      title: "The feature",
      summary: "Adds the feature.",
      attention: null,
      files: [{ path: "feature.txt" }],
      questions: [],
    },
  ],
  notes: [
    {
      groupId: "feature",
      path: "feature.txt",
      side: "new",
      start: 1,
      end: 1,
      summary: "Adds the line.",
    },
  ],
});

/** A selection the stub provider refuses to investigate with; any other model can. */
const CANNOT: ModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "no-tools" };
const CANNOT_REFUSAL = "That model cannot investigate a checkout read-only.";

/** Test settings that announce their changes, so `unavailable` can follow them. */
const layerSettings = (overrides: Parameters<typeof ServerSettings.layerTest>[0]) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const base = yield* ServerSettings.ServerSettingsService;
      const changes = yield* PubSub.unbounded<ServerSettingsValue>();
      return ServerSettings.ServerSettingsService.of({
        ...base,
        updateSettings: (patch) =>
          base.updateSettings(patch).pipe(Effect.tap((next) => PubSub.publish(changes, next))),
        subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      });
    }),
  ).pipe(Layer.provide(ServerSettings.layerTest(overrides)));

const makeLayer = (input: {
  readonly repositories: Repositories;
  readonly generate: TextGeneration.TextGeneration["Service"]["generateDiffWalkthrough"];
  /** The head the host reports now, for a test that pushes between runs. */
  readonly currentHead?: Ref.Ref<string>;
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
}) => {
  const { repositories } = input;
  const project: OrchestrationProjectShell = {
    id: projectId,
    title: "App",
    workspaceRoot: repositories.workspace,
    defaultModelSelection: null,
    scripts: [],
    repositoryIdentity: ACME_APP,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  const thread = v2PullRequestThread({
    id: threadId,
    projectId,
    title: "Add the feature",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: null,
  });
  const detail = (headSha: string) =>
    ({
      number: 7,
      title: "Add the feature",
      body: "Adds the feature.",
      baseBranch: "main",
      headBranch: "feature",
      headSha,
    }) as PullRequestDetail;
  return DiffWalkthroughRunService.layer.pipe(
    Layer.provide(
      DiffWalkthroughWriter.layer.pipe(Layer.provide(DiffWalkthroughChangeReader.layer)),
    ),
    Layer.provideMerge(DiffWalkthroughService.layer.pipe(Layer.provide(DiffWalkthroughs.layer))),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getShell: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(null),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadShell: (id) => Effect.succeed(id === threadId ? thread : null),
        }),
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            (input.currentHead === undefined
              ? Effect.succeed(repositories.headSha)
              : Ref.get(input.currentHead)
            ).pipe(Effect.map(detail)),
          invalidate: () => Effect.void,
          // Notes on a pull request stand as written; branch ranges hold them to local git.
          diff: () =>
            Effect.fail(
              new PullRequestOperationError({ operation: "diff", detail: "No host in tests." }),
            ),
        }),
        // Turn 1's checkpoint is the base commit and turn 2's is the change.
        Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({
          resolveTurnRange: () =>
            Effect.succeed({
              cwd: repositories.workspace,
              fromCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/test/turn/1"),
              toCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/test/turn/2"),
            }),
        }),
        Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.succeed([]),
          streamChanges: Stream.empty,
        } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
        Layer.mock(TextGeneration.TextGeneration)({
          generateDiffWalkthrough: input.generate,
          investigationRefusal: (selection) =>
            Effect.succeed(selection.model === CANNOT.model ? CANNOT_REFUSAL : null),
        }),
        ServerConfig.layerTest(repositories.root, { prefix: "t3-walkthrough-run-config-" }),
        SqlitePersistence.layerMemory,
      ),
    ),
    Layer.provideMerge(
      layerSettings({ reviewGuideInstructions: "Lead with the contract.", ...input.settings }),
    ),
  );
};

const buildServices = (layer: ReturnType<typeof makeLayer>) =>
  // Built in the test's scope: runs are forked into the service's scope and must outlive the
  // call that obtains the service.
  Layer.build(layer).pipe(
    Effect.map((context) => ({
      service: Context.get(context, DiffWalkthroughRunService.DiffWalkthroughRunService),
      settings: Context.get(context, ServerSettings.ServerSettingsService),
    })),
  );

const buildService = (layer: ReturnType<typeof makeLayer>) =>
  buildServices(layer).pipe(Effect.map(({ service }) => service));

/** Follows a target's subscription; `until` waits for a state and returns what came before. */
const watch = (
  service: DiffWalkthroughRunService.DiffWalkthroughRunService["Service"],
  target: DiffWalkthroughTargetIdentity,
) =>
  Effect.gen(function* () {
    const states = yield* Queue.unbounded<DiffWalkthroughGetResult>();
    yield* service.subscribe(target).pipe(
      Stream.runForEach((state) => Queue.offer(states, state)),
      Effect.forkScoped,
    );
    // The first state means the subscription is live, so no later change is missed.
    const first = yield* Queue.take(states);
    const until = (predicate: (state: DiffWalkthroughGetResult) => boolean) =>
      Effect.gen(function* () {
        const seen: DiffWalkthroughGetResult[] = [];
        while (true) {
          const state = yield* Queue.take(states);
          seen.push(state);
          if (predicate(state)) return { state, seen };
        }
      });
    return { first, until };
  });

/** What the fake model saw in its checkout. */
interface Observed {
  readonly input: DiffWalkthroughGenerationInput;
  readonly head: string;
  readonly changed: string;
}

const observe = (
  input: DiffWalkthroughGenerationInput,
  driver: GitVcsDriver.GitVcsDriver["Service"],
) => {
  const read = (args: ReadonlyArray<string>) =>
    git(input.cwd, args).pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      Effect.orDie,
    );
  return Effect.all({
    head: read(["rev-parse", "HEAD"]),
    changed: read(["diff", "--name-only", input.baseCommit, "HEAD"]),
  }).pipe(Effect.map((read): Observed => ({ input, ...read })));
};

const layerBase = Layer.mergeAll(
  GitVcsDriver.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-walkthrough-run-git-" })),
    Layer.provideMerge(VcsProcess.layer),
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

// Runs drive real git, which the test clock does not advance.
it.layer(layerBase, { excludeTestServices: true })("DiffWalkthroughRunService", (it) => {
  it.effect(
    "walks a branch from a checkout of its head, joins a second press, then cleans up",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repositories = yield* makeRepositories;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const seen = yield* Deferred.make<Observed>();
          const finish = yield* Deferred.make<void>();
          const service = yield* buildService(
            makeLayer({
              repositories,
              generate: (input) =>
                observe(input, driver).pipe(
                  Effect.flatMap((observed) => Deferred.succeed(seen, observed)),
                  Effect.andThen(Deferred.await(finish)),
                  Effect.as(answer("A branch walkthrough.")),
                ),
            }),
          );
          const target = branchTarget(repositories);
          const watched = yield* watch(service, target);
          assert.deepStrictEqual(watched.first, {
            walkthrough: null,
            run: null,
            unavailable: null,
          });

          const started = yield* service.generate(target);
          assert.isTrue(started.started);
          assert.deepStrictEqual(started.run.target, target);
          const observed = yield* Deferred.await(seen);
          // The checkout is the branch's head, measured from the range's base.
          assert.strictEqual(observed.head, repositories.headSha);
          assert.strictEqual(observed.changed, "feature.txt");
          assert.strictEqual(observed.input.baseCommit, repositories.baseSha);
          assert.isTrue(observed.input.hasCommitHistory);
          assert.include(observed.input.subject, "feature");
          assert.include(observed.input.stat, "feature.txt");
          assert.strictEqual(observed.input.instructions, "Lead with the contract.");
          assert.notInclude(observed.input.cwd, repositories.workspace);

          // A second press while running joins the run instead of starting another.
          const joined = yield* service.generate(target);
          assert.isFalse(joined.started);
          assert.strictEqual(joined.run, started.run);

          yield* Deferred.succeed(finish, undefined);
          const { state, seen: states } = yield* watched.until(
            (next) => next.walkthrough !== null && next.run === null,
          );
          assert.isTrue(states.some((next) => next.run?._tag === "Running"));
          assert.deepStrictEqual(state.walkthrough?.target, target);
          assert.strictEqual(state.walkthrough?.summary, "A branch walkthrough.");
          assert.isUndefined(state.walkthrough?.author.threadId);
          assert.isDefined(state.walkthrough?.author.model);

          const fs = yield* FileSystem.FileSystem;
          assert.isFalse(yield* fs.exists(observed.input.cwd));
          const worktrees = yield* git(repositories.workspace, ["worktree", "list", "--porcelain"]);
          assert.notInclude(worktrees, observed.input.cwd);
        }),
      ),
  );

  it.effect("keeps a model's failure as the failed run until the next press, and cleans up", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const cwds = yield* Ref.make<ReadonlyArray<string>>([]);
        const service = yield* buildService(
          makeLayer({
            repositories,
            generate: (input) =>
              Ref.update(cwds, (current) => [...current, input.cwd]).pipe(
                Effect.andThen(
                  Effect.fail(investigationUnsupported("generateDiffWalkthrough", "Cursor")),
                ),
              ),
          }),
        );
        const target = branchTarget(repositories);
        const watched = yield* watch(service, target);

        yield* service.generate(target);
        const { state } = yield* watched.until((next) => next.run?._tag === "Failed");
        assert.strictEqual(state.walkthrough, null);
        assert.strictEqual(state.run?._tag, "Failed");
        if (state.run?._tag === "Failed") {
          assert.include(state.run.detail, "Cursor cannot investigate a checkout read-only");
          assert.deepStrictEqual(state.run.target, target);
        }
        const fs = yield* FileSystem.FileSystem;
        const [cwd] = yield* Ref.get(cwds);
        assert.isDefined(cwd);
        assert.isFalse(yield* fs.exists(cwd!));

        // The next press replaces the failure with a new run.
        const again = yield* service.generate(target);
        assert.isTrue(again.started);
        yield* watched.until((next) => next.run?._tag === "Running");
      }),
    ),
  );

  it.effect("fails a run whose model wrote a walkthrough the contract rejects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const valid = answer("Broken.");
        const service = yield* buildService(
          makeLayer({
            repositories,
            generate: () =>
              Effect.succeed({
                ...valid,
                notes: valid.notes.map((note) => ({ ...note, groupId: "nowhere" })),
              }),
          }),
        );
        const target = branchTarget(repositories);
        const watched = yield* watch(service, target);
        yield* service.generate(target);
        const { state } = yield* watched.until((next) => next.run?._tag === "Failed");
        assert.strictEqual(state.walkthrough, null);
        if (state.run?._tag === "Failed") {
          assert.include(state.run.detail, "The model wrote an invalid walkthrough");
          assert.include(state.run.detail, 'unknown group "nowhere"');
        }
      }),
    ),
  );

  it.effect("fails with the reason when the pull request's head cannot be fetched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        // A head the host reports but the remote does not have, under no pull request ref.
        const missing = "f".repeat(40);
        const currentHead = yield* Ref.make(missing);
        const service = yield* buildService(
          makeLayer({
            repositories,
            currentHead,
            generate: () => Effect.die("a run that could not fetch must not reach the model"),
          }),
        );
        const target = pullRequestTarget(missing);
        const watched = yield* watch(service, target);
        yield* service.generate(target);
        const { state } = yield* watched.until((next) => next.run?._tag === "Failed");
        if (state.run?._tag === "Failed") {
          assert.include(state.run.detail, "Could not fetch the pull request's head.");
        }
        const worktrees = yield* git(repositories.workspace, ["worktree", "list", "--porcelain"]);
        assert.notInclude(worktrees, "diff-walkthrough-");
      }),
    ),
  );

  it.effect("keeps a newer head's walkthrough when an older run finishes late", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const currentHead = yield* Ref.make(repositories.headSha);
        const oldStarted = yield* Deferred.make<Observed>();
        const releaseOld = yield* Deferred.make<void>();
        const dropped = yield* Deferred.make<void>();
        const logger = Logger.make(({ message }) => {
          if ([message].flat().includes(DiffWalkthroughRunService.DROPPED_SUPERSEDED_RUN)) {
            Deferred.doneUnsafe(dropped, Effect.void);
          }
        });
        const service = yield* buildService(
          makeLayer({
            repositories,
            currentHead,
            // The run for the first head waits to be released; the newer one answers at once.
            generate: (input) =>
              observe(input, driver).pipe(
                Effect.flatMap((observed) =>
                  observed.head === repositories.headSha
                    ? Deferred.succeed(oldStarted, observed).pipe(
                        Effect.andThen(Deferred.await(releaseOld)),
                        Effect.as(answer("old head")),
                      )
                    : Effect.succeed(answer("new head")),
                ),
              ),
          }),
        );
        const older = pullRequestTarget(repositories.headSha);
        const watched = yield* watch(service, older);

        yield* service.generate(older).pipe(Effect.provide(Logger.layer([logger])));
        const oldObserved = yield* Deferred.await(oldStarted);
        // Measured from where the head left main, not from main's tip.
        assert.strictEqual(oldObserved.input.baseCommit, repositories.baseSha);
        assert.strictEqual(oldObserved.changed, "feature.txt");
        assert.include(oldObserved.input.subject, "#7");
        assert.strictEqual(oldObserved.input.description, "Adds the feature.");

        // A press for an older head than the host reports now is refused.
        yield* Ref.set(currentHead, repositories.newerHeadSha);
        const stale = yield* Effect.flip(service.generate(older));
        assert.include(stale.message, "moved to another head");

        // A push: the newer head's run replaces the older one and stores its walkthrough.
        const newer = pullRequestTarget(repositories.newerHeadSha);
        const second = yield* service.generate(newer);
        assert.isTrue(second.started);
        const stored = yield* watched.until(
          (next) => next.walkthrough !== null && next.run === null,
        );
        assert.strictEqual(stored.state.walkthrough?.summary, "new head");

        // The older run finishes last; its walkthrough is for a head nobody is looking at.
        yield* Deferred.succeed(releaseOld, undefined);
        yield* Deferred.await(dropped);
        const after = yield* service.subscribe(older).pipe(Stream.runHead);
        assert.isTrue(Option.isSome(after));
        if (Option.isSome(after)) {
          assert.isNull(after.value.run);
          assert.strictEqual(after.value.walkthrough?.summary, "new head");
          const storedTarget: DiffWalkthroughTarget | undefined = after.value.walkthrough?.target;
          assert.strictEqual(
            storedTarget?.kind === "pull-request" ? storedTarget.headSha : null,
            repositories.newerHeadSha,
          );
        }
      }),
    ),
  );

  it.effect("walks a thread's checkpoint pair from a checkout of the later checkpoint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(repositories.workspace, [
          "update-ref",
          "refs/t3/checkpoints/test/turn/1",
          repositories.baseSha,
        ]);
        yield* git(repositories.workspace, [
          "update-ref",
          "refs/t3/checkpoints/test/turn/2",
          repositories.headSha,
        ]);
        const seen = yield* Deferred.make<Observed>();
        const service = yield* buildService(
          makeLayer({
            repositories,
            generate: (input) =>
              observe(input, driver).pipe(
                Effect.flatMap((observed) => Deferred.succeed(seen, observed)),
                Effect.as(answer("A thread walkthrough.")),
              ),
          }),
        );
        const watched = yield* watch(service, threadTarget);
        yield* service.generate(threadTarget);
        const observed = yield* Deferred.await(seen);
        assert.strictEqual(observed.head, repositories.headSha);
        assert.strictEqual(observed.input.baseCommit, repositories.baseSha);
        assert.strictEqual(observed.changed, "feature.txt");
        // Checkpoints are snapshots; there is no commit history to read between them.
        assert.isFalse(observed.input.hasCommitHistory);
        assert.include(observed.input.subject, "turn 2");
        const { state } = yield* watched.until(
          (next) => next.walkthrough !== null && next.run === null,
        );
        assert.deepStrictEqual(state.walkthrough?.target, threadTarget);

        // An empty range has nothing to walk, and is refused before a run starts.
        const empty = yield* Effect.flip(
          service.generate({ ...threadTarget, fromTurnCount: 2, toTurnCount: 2 }),
        );
        assert.include(empty.message, "no change to walk through");
      }),
    ),
  );
  it.effect("refuses up front on a model that cannot investigate, and says why until it can", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const { service, settings } = yield* buildServices(
          makeLayer({
            repositories,
            generate: () => Effect.die("a refused run must not reach the model"),
            settings: { textGenerationModelSelection: CANNOT },
          }),
        );
        const target = branchTarget(repositories);
        const watched = yield* watch(service, target);
        assert.strictEqual(watched.first.unavailable, CANNOT_REFUSAL);

        // The press fails with the reason; no run is claimed and nothing is checked out.
        const refused = yield* Effect.flip(service.generate(target));
        assert.strictEqual(refused.message, CANNOT_REFUSAL);
        const after = yield* service.subscribe(target).pipe(Stream.runHead);
        assert.isTrue(Option.isSome(after) && after.value.run === null);
        const worktrees = yield* git(repositories.workspace, ["worktree", "list", "--porcelain"]);
        assert.notInclude(worktrees, "diff-walkthrough-");

        // Choosing a model that can investigate clears it, and choosing one that cannot sets it.
        yield* settings.updateSettings({
          textGenerationModelSelection: { ...CANNOT, model: "gpt-5" },
        });
        yield* watched.until((next) => next.unavailable === null);
        yield* settings.updateSettings({ textGenerationModelSelection: CANNOT });
        yield* watched.until((next) => next.unavailable === CANNOT_REFUSAL);
      }),
    ),
  );

  it.effect("holds a background walkthrough's notes to the lines the change touched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const written = answer("Held.");
        const service = yield* buildService(
          makeLayer({
            repositories,
            generate: () =>
              Effect.succeed({
                ...written,
                groups: written.groups.map((group) => ({
                  ...group,
                  files: [...group.files, { path: "base.txt" }],
                })),
                notes: [
                  // feature.txt has one line; a note reaching past it is narrowed to it.
                  { ...written.notes[0]!, start: 1, end: 3 },
                  // base.txt did not change on the branch; a note on it is dropped.
                  { ...written.notes[0]!, path: "base.txt", summary: "Unchanged." },
                ],
              }),
          }),
        );
        const target = branchTarget(repositories);
        const watched = yield* watch(service, target);
        yield* service.generate(target);
        const { state } = yield* watched.until(
          (next) => next.walkthrough !== null && next.run === null,
        );
        assert.deepStrictEqual(
          state.walkthrough?.notes.map(({ path, start, end }) => ({ path, start, end })),
          [{ path: "feature.txt", start: 1, end: 1 }],
        );
      }),
    ),
  );
});
