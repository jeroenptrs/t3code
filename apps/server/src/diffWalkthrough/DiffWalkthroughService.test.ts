import { assert, describe, it } from "@effect/vitest";
import {
  type DiffWalkthrough,
  type DiffWalkthroughPullRequestTarget,
  type DiffWalkthroughTarget,
  type OrchestrationProjectShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { v2PullRequestThread } from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as DiffWalkthroughs from "../persistence/DiffWalkthroughs.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as DiffWalkthroughService from "./DiffWalkthroughService.ts";

const PROJECT_ID = ProjectId.make("project-1");
const HOSTLESS_PROJECT_ID = ProjectId.make("project-without-remote");
const THREAD_ID = ThreadId.make("thread-1");

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: "/workspace/project",
  defaultModelSelection: null,
  scripts: [],
  repositoryIdentity: {
    canonicalKey: "github.com/t3tools/t3code",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:T3Tools/T3Code.git",
    },
    provider: "github",
    displayName: "T3Tools/T3Code",
    owner: "T3Tools",
    name: "T3Code",
  },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const thread = v2PullRequestThread({
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  latestUserMessageAt: null,
});

const layer = DiffWalkthroughService.layer.pipe(
  Layer.provide(DiffWalkthroughs.layer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProjectService.ProjectService)({
        getShell: (projectId) =>
          Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
      }),
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed(null),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadShell: (threadId) => Effect.succeed(threadId === THREAD_ID ? thread : null),
      }),
    ),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const pullRequest = (
  overrides: Partial<DiffWalkthroughPullRequestTarget> = {},
): DiffWalkthroughPullRequestTarget => ({
  kind: "pull-request",
  projectId: PROJECT_ID,
  repository: "t3tools/t3code",
  number: 42,
  headSha: "aaaaaaa",
  ...overrides,
});

const walkthroughFor = (
  target: DiffWalkthroughTarget,
  summary = "First pass",
): DiffWalkthrough => ({
  target,
  summary,
  groups: [
    {
      id: "core",
      title: "Core change",
      summary: "The behavior the change is about.",
      files: ["src/a.ts"],
    },
  ],
  notes: [
    {
      groupId: "core",
      path: "src/a.ts",
      side: "additions",
      startLine: 1,
      endLine: 3,
      summary: "Adds the entry point",
    },
  ],
  generatedAt: "2026-10-09T00:00:00.000Z",
  author: { provider: "codex" },
});

const rowCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM fork_diff_walkthroughs
  `;
  return rows[0]?.count;
});

describe("DiffWalkthroughService", () => {
  it.effect("returns what was stored for a thread's checkpoint pair", () =>
    Effect.gen(function* () {
      const service = yield* DiffWalkthroughService.DiffWalkthroughService;
      const target: DiffWalkthroughTarget = {
        kind: "thread-diff",
        threadId: THREAD_ID,
        fromTurnCount: 1,
        toTurnCount: 2,
      };
      assert.isNull(yield* service.get(target));
      const stored = yield* service.put(walkthroughFor(target));
      assert.deepStrictEqual(stored, walkthroughFor(target));
      assert.deepStrictEqual(yield* service.get(target), stored);
      // Another checkpoint pair of the same thread is another walkthrough.
      assert.isNull(yield* service.get({ ...target, toTurnCount: 3 }));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("replaces a pull request's walkthrough when one is written for a new head", () =>
    Effect.gen(function* () {
      const service = yield* DiffWalkthroughService.DiffWalkthroughService;
      yield* service.put(walkthroughFor(pullRequest({ headSha: "aaaaaaa" }), "Old head"));
      yield* service.put(walkthroughFor(pullRequest({ headSha: "bbbbbbb" }), "New head"));
      // Looked up by the live head, which the stored one may or may not match.
      const current = yield* service.get(pullRequest({ headSha: "ccccccc" }));
      assert.strictEqual(current?.summary, "New head");
      assert.strictEqual(yield* rowCount, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps one walkthrough for a pull request named with and without its host", () =>
    Effect.gen(function* () {
      const service = yield* DiffWalkthroughService.DiffWalkthroughService;
      const stored = yield* service.put(walkthroughFor(pullRequest(), "Hostless"));
      assert.deepStrictEqual(stored.target, { ...pullRequest(), host: "github.com" });
      assert.strictEqual(
        (yield* service.get(pullRequest({ host: "GitHub.com" })))?.summary,
        "Hostless",
      );
      yield* service.put(walkthroughFor(pullRequest({ host: "github.com" }), "Hosted"));
      assert.strictEqual((yield* service.get(pullRequest()))?.summary, "Hosted");
      assert.strictEqual(yield* rowCount, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keys a pull request by its project when the project's host is unknown", () =>
    Effect.gen(function* () {
      const service = yield* DiffWalkthroughService.DiffWalkthroughService;
      const target = pullRequest({ projectId: HOSTLESS_PROJECT_ID });
      const stored = yield* service.put(walkthroughFor(target));
      assert.deepStrictEqual(stored.target, target);
      assert.deepStrictEqual(yield* service.get(target), stored);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("streams the stored walkthrough, then each replacement for the same target", () =>
    Effect.gen(function* () {
      const service = yield* DiffWalkthroughService.DiffWalkthroughService;
      const first = yield* service.put(walkthroughFor(pullRequest(), "First"));
      const subscribed = yield* Deferred.make<void>();
      const fiber = yield* service.subscribe(pullRequest({ host: "github.com" })).pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      // Another pull request's walkthrough is not this subscriber's.
      yield* service.put(walkthroughFor(pullRequest({ number: 7 }), "Elsewhere"));
      const second = yield* service.put(
        walkthroughFor(pullRequest({ headSha: "bbbbbbb" }), "Second"),
      );
      assert.deepStrictEqual(Array.from(yield* Fiber.join(fiber)), [first, second]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("starts a subscription with null when nothing is stored", () =>
    Effect.gen(function* () {
      const service = yield* DiffWalkthroughService.DiffWalkthroughService;
      const items = yield* service.subscribe(pullRequest()).pipe(Stream.take(1), Stream.runCollect);
      assert.deepStrictEqual(Array.from(items), [null]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a walkthrough for a thread that does not exist", () =>
    Effect.gen(function* () {
      const service = yield* DiffWalkthroughService.DiffWalkthroughService;
      const error = yield* service
        .put(
          walkthroughFor({
            kind: "thread-diff",
            threadId: ThreadId.make("thread-missing"),
            fromTurnCount: 0,
            toTurnCount: 1,
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "DiffWalkthroughError");
      assert.strictEqual(yield* rowCount, 0);
    }).pipe(Effect.provide(layer)),
  );
});
