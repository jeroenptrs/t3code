import {
  EnvironmentId,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewSource,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import * as DiffWalkthroughService from "../../../diffWalkthrough/DiffWalkthroughService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as DiffWalkthroughs from "../../../persistence/DiffWalkthroughs.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import * as ReviewService from "../../../review/ReviewService.ts";
import { OUTPUT_TRUNCATED_MARKER } from "../../../vcs/GitVcsDriverCore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as DiffWalkthroughHandlers from "./handlers.ts";
import { boundReviewDiff, boundThreadDiff } from "./handlers.ts";
import { DiffWalkthroughToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const OTHER_THREAD_ID = ThreadId.make("thread-2");

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

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["orchestration"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

interface HarnessOptions {
  /** Threads besides the caller, which is a live full-access one. */
  readonly threads?: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly caller?: OrchestrationV2ThreadShell;
  readonly diff?: string;
  /** The review diff sources the caller's checkout reports. */
  readonly reviewSources?: ReadonlyArray<ReviewDiffPreviewSource>;
}

const reviewSource = (
  overrides: Partial<ReviewDiffPreviewSource> = {},
): ReviewDiffPreviewSource => ({
  id: "branch-range",
  kind: "branch-range",
  title: "Changes vs main",
  baseRef: "main",
  headRef: "feature/walkthrough",
  diff: "",
  diffHash: "hash",
  truncated: false,
  files: [],
  baseSha: "base0000000000000000",
  headSha: "head0000000000000000",
  ...overrides,
});

const makeHarness = Effect.fn("makeDiffWalkthroughToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>(
    [
      options.caller ?? {
        ...McpToolAccessTestkit.liveThreadShell(THREAD_ID),
        projectId: PROJECT_ID,
      },
      ...(options.threads ?? []),
    ].map((shell) => [shell.id, shell]),
  );
  const getThreadShell = (threadId: ThreadId) => Effect.succeed(shells.get(threadId) ?? null);
  const diffRequests: Array<OrchestrationGetTurnDiffInput> = [];
  const reviewRequests: Array<ReviewDiffPreviewInput> = [];
  let reviewSources = options.reviewSources ?? [reviewSource()];
  const layerDependencies = Layer.mergeAll(
    DiffWalkthroughService.layer.pipe(
      Layer.provide(DiffWalkthroughs.layer),
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(null),
        }),
      ),
    ),
    Layer.mock(ReviewService.ReviewService)({
      getDiffPreview: (input) => {
        reviewRequests.push(input);
        return DateTime.now.pipe(
          Effect.map((generatedAt) => ({ cwd: input.cwd, generatedAt, sources: reviewSources })),
        );
      },
    }),
    Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({
      getTurnDiff: (input) => {
        diffRequests.push(input);
        return Effect.succeed({
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          diff: options.diff ?? "",
        });
      },
    }),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getShell: (projectId) =>
            Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({ getThreadShell }),
        Layer.mock(ThreadManagement.ThreadManagementService)({ getThreadShell }),
      ),
    ),
  );
  // Built into the test's scope, so the database outlives the harness's construction.
  const context = yield* Layer.build(layerDependencies);
  return yield* Effect.gen(function* () {
    const toolkit = yield* DiffWalkthroughToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(DiffWalkthroughHandlers.layer)),
    );
    const walkthroughs = yield* DiffWalkthroughService.DiffWalkthroughService;
    const call = <Name extends keyof typeof DiffWalkthroughToolkit.tools>(
      name: Name,
      params: Parameters<typeof toolkit.handle<Name>>[1],
      capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>,
    ) =>
      toolkit.handle(name, params).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map(
          (chunk) =>
            chunk.at(-1)!.result as Tool.Success<(typeof DiffWalkthroughToolkit.tools)[Name]>,
        ),
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
        Effect.provideContext(context),
      );
    const setReviewSources = (sources: ReadonlyArray<ReviewDiffPreviewSource>) => {
      reviewSources = sources;
    };
    return { call, walkthroughs, diffRequests, reviewRequests, setReviewSources };
  }).pipe(Effect.provideContext(context));
});

const groups = [
  {
    id: "core",
    title: "Core change",
    summary: "Stores walkthroughs.",
    files: ["src/a.ts"],
  },
];

describe("diff walkthrough toolkit handlers", () => {
  it.effect("stores a pull request walkthrough by URL with its resolved identity and author", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("write_diff_walkthrough", {
        target: {
          kind: "pull-request",
          url: "https://github.com/T3Tools/T3Code/pull/42",
          headSha: "abc123",
        },
        summary: "Adds walkthroughs.",
        groups,
        notes: [
          {
            groupId: "core",
            path: "src/a.ts",
            side: "additions",
            startLine: 1,
            endLine: 4,
            summary: "Writes the row.",
          },
        ],
      });
      const target = {
        kind: "pull-request" as const,
        projectId: PROJECT_ID,
        host: "github.com",
        repository: "t3tools/t3code",
        number: 42,
        headSha: "abc123",
      };
      assert.deepStrictEqual(result.target, target);
      assert.strictEqual(result.groupCount, 1);
      assert.strictEqual(result.noteCount, 1);

      const stored = yield* harness.walkthroughs.get(target);
      assert.deepStrictEqual(stored?.author, {
        threadId: THREAD_ID,
        provider: "codex",
        model: "gpt-5",
      });
      assert.strictEqual(stored?.summary, "Adds walkthroughs.");
      assert.isTrue(Number.isFinite(Date.parse(stored?.generatedAt ?? "")));
    }),
  );

  it.effect("names the problem when a note sits on a file outside its group", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("write_diff_walkthrough", {
          target: { kind: "thread-diff", fromTurnCount: 0, toTurnCount: 1 },
          groups,
          notes: [
            {
              groupId: "core",
              path: "src/b.ts",
              side: "additions",
              startLine: 1,
              endLine: 1,
              summary: "Elsewhere.",
            },
          ],
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "DiffWalkthroughRejectedError");
      assert.include(error.message, 'note on "src/b.ts" is not a file of group "core"');
    }),
  );

  it.effect("writes a thread diff walkthrough for the calling thread by default", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("write_diff_walkthrough", {
        target: { kind: "thread-diff", fromTurnCount: 1, toTurnCount: 2 },
        groups,
        notes: [],
      });
      assert.deepStrictEqual(result.target, {
        kind: "thread-diff",
        threadId: THREAD_ID,
        fromTurnCount: 1,
        toTurnCount: 2,
      });
    }),
  );

  it.effect("refuses to write for a thread running above the caller's modes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        caller: {
          ...McpToolAccessTestkit.liveThreadShell(THREAD_ID, {
            runtimeMode: "approval-required",
          }),
          projectId: PROJECT_ID,
        },
        threads: [
          { ...McpToolAccessTestkit.liveThreadShell(OTHER_THREAD_ID), projectId: PROJECT_ID },
        ],
      });
      const error = yield* harness
        .call("write_diff_walkthrough", {
          target: {
            kind: "thread-diff",
            threadId: OTHER_THREAD_ID,
            fromTurnCount: 0,
            toTurnCount: 1,
          },
          groups,
          notes: [],
        })
        .pipe(Effect.flip);
      assert.deepInclude(error, {
        _tag: "OrchestratorMcpFailure",
        code: "runtime_mode_escalation_denied",
      });
    }),
  );

  it.effect(
    "reads the calling thread's diff and refuses a credential that cannot read threads",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ diff: "diff --git a/x b/x\n" });
        const result = yield* harness.call("read_thread_diff", {
          target: { kind: "thread-diff", fromTurnCount: 0, toTurnCount: 3 },
        });
        assert.deepStrictEqual(harness.diffRequests, [
          { threadId: THREAD_ID, fromTurnCount: 0, toTurnCount: 3 },
        ]);
        assert.strictEqual(result.diff, "diff --git a/x b/x\n");
        assert.isFalse(result.truncated);

        const error = yield* harness
          .call(
            "read_thread_diff",
            { target: { kind: "thread-diff", fromTurnCount: 0, toTurnCount: 1 } },
            ["preview"],
          )
          .pipe(Effect.flip);
        assert.deepInclude(error, { _tag: "OrchestratorMcpFailure", code: "capability_denied" });
      }),
  );
});

describe("branch-range walkthroughs", () => {
  const branchTarget = {
    kind: "branch-range" as const,
    projectId: PROJECT_ID,
    branch: "feature/walkthrough",
    baseSha: "base0000000000000000",
    headSha: "head0000000000000000",
  };

  it.effect("writes the calling thread's branch range, read from its worktree", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        caller: {
          ...McpToolAccessTestkit.liveThreadShell(THREAD_ID),
          projectId: PROJECT_ID,
          worktreePath: "/worktrees/feature",
        },
      });
      const result = yield* harness.call("write_diff_walkthrough", {
        target: { kind: "branch-range" },
        groups,
        notes: [],
      });
      assert.deepStrictEqual(result.target, branchTarget);
      assert.include(result.confirmation, "branch feature/walkthrough");
      assert.strictEqual(harness.reviewRequests[0]?.cwd, "/worktrees/feature");
      const stored = yield* harness.walkthroughs.get({
        kind: "branch-range",
        projectId: PROJECT_ID,
        branch: "feature/walkthrough",
      });
      assert.deepStrictEqual(stored?.target, branchTarget);
    }),
  );

  it.effect("refuses a detached checkout with a message the agent can act on", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ reviewSources: [reviewSource({ headRef: "HEAD" })] });
      const error = yield* harness
        .call("write_diff_walkthrough", { target: { kind: "branch-range" }, groups, notes: [] })
        .pipe(Effect.flip);
      assert.deepInclude(error, {
        _tag: "BranchRangeUnavailableError",
        message: "The thread's checkout is not on a branch (detached HEAD).",
      });
    }),
  );

  it.effect("names the file and both groups when a file is placed twice", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("write_diff_walkthrough", {
          target: { kind: "branch-range" },
          groups: [...groups, { ...groups[0]!, id: "again", title: "Again" }],
          notes: [],
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "DiffWalkthroughRejectedError");
      assert.include(error.message, 'file "src/a.ts" is in both group "core" and group "again"');
    }),
  );

  it.effect("reads the branch diff with its range and uncommitted state", () =>
    Effect.gen(function* () {
      const kept = "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
      const harness = yield* makeHarness({
        reviewSources: [
          reviewSource({
            diff: `${kept}diff --git a/src/b.ts b/src/b.ts\n@@ -1 +1 @@\n-a${OUTPUT_TRUNCATED_MARKER}`,
            truncated: true,
            files: [
              { path: "src/a.ts", previousPath: null, additions: 1, deletions: 1 },
              { path: "src/b.ts", previousPath: null, additions: 1, deletions: 1 },
            ],
          }),
          reviewSource({ id: "working-tree", kind: "working-tree", diff: "diff --git x" }),
        ],
      });
      const result = yield* harness.call("read_thread_diff", {
        target: { kind: "branch-range" },
      });
      assert.deepStrictEqual(result, {
        kind: "branch-range",
        threadId: THREAD_ID,
        branch: "feature/walkthrough",
        baseRef: "main",
        baseSha: branchTarget.baseSha,
        headSha: branchTarget.headSha,
        includesUncommittedChanges: true,
        diff: kept,
        truncated: true,
        omittedFiles: ["src/b.ts"],
      });
      assert.strictEqual(harness.reviewRequests[0]?.ignoreWhitespace, true);
    }),
  );

  it.effect("reads a stored walkthrough and tells when the branch has moved", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const before = yield* harness.call("read_diff_walkthrough", {
        target: { kind: "branch-range" },
      });
      assert.deepStrictEqual(before, { walkthrough: null, stale: null });

      yield* harness.call("write_diff_walkthrough", {
        target: { kind: "branch-range" },
        groups,
        notes: [],
      });
      const current = yield* harness.call("read_diff_walkthrough", {
        target: { kind: "branch-range" },
      });
      assert.deepStrictEqual(current.walkthrough?.target, branchTarget);
      assert.isFalse(current.stale);

      harness.setReviewSources([reviewSource({ headSha: "head1111111111111111" })]);
      const moved = yield* harness.call("read_diff_walkthrough", {
        target: { kind: "branch-range" },
      });
      assert.deepStrictEqual(moved.walkthrough?.target, branchTarget);
      assert.isTrue(moved.stale);
    }),
  );

  it.effect("reads pull request and thread diff walkthroughs another agent wrote", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call("write_diff_walkthrough", {
        target: { kind: "pull-request", repository: "T3Tools/T3Code", number: 7, headSha: "abc" },
        groups,
        notes: [],
      });
      const pullRequest = yield* harness.call("read_diff_walkthrough", {
        target: { kind: "pull-request", url: "https://github.com/t3tools/t3code/pull/7" },
      });
      assert.strictEqual(pullRequest.walkthrough?.target.kind, "pull-request");
      assert.isNull(pullRequest.stale);

      yield* harness.call("write_diff_walkthrough", {
        target: { kind: "thread-diff", fromTurnCount: 0, toTurnCount: 2 },
        groups,
        notes: [],
      });
      const threadDiff = yield* harness.call("read_diff_walkthrough", {
        target: { kind: "thread-diff", fromTurnCount: 0, toTurnCount: 2 },
      });
      assert.strictEqual(threadDiff.walkthrough?.target.kind, "thread-diff");
      assert.isFalse(threadDiff.stale);
    }),
  );
});

describe("boundReviewDiff", () => {
  it("leaves a complete diff alone and names nothing", () => {
    const diff = "diff --git a/a b/a\n+x\n";
    assert.deepStrictEqual(
      boundReviewDiff({
        diff,
        truncated: false,
        files: [{ path: "a", previousPath: null, additions: 1, deletions: 0 }],
      }),
      { diff, truncated: false, omittedFiles: [] },
    );
  });

  it("drops a file git cut partway, and an only file leaves nothing", () => {
    assert.deepStrictEqual(
      boundReviewDiff({
        diff: `diff --git a/a b/a\n+x${OUTPUT_TRUNCATED_MARKER}`,
        truncated: true,
        files: [{ path: "a", previousPath: null, additions: 1, deletions: 0 }],
      }),
      { diff: "", truncated: true, omittedFiles: ["a"] },
    );
  });
});

describe("boundThreadDiff", () => {
  const section = (header: string, body: string) => `${header}\n${body}`;
  const modified = section(
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  );
  const deleted = section(
    "diff --git a/src/gone.ts b/src/gone.ts",
    "deleted file mode 100644\n--- a/src/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n",
  );
  const spaced = section(
    "diff --git a/docs/read me.md b/docs/read me.md",
    "--- a/docs/read me.md\t\n+++ b/docs/read me.md\t\n@@ -1 +1 @@\n-a\n+b\n",
  );
  const binary = section(
    "diff --git a/img/logo.png b/img/logo.png",
    "Binary files a/img/logo.png and b/img/logo.png differ\n",
  );
  const diff = modified + deleted + spaced + binary;

  it("leaves a diff within the limit alone", () => {
    assert.deepStrictEqual(boundThreadDiff(diff, diff.length), { diff, omittedFiles: [] });
  });

  it("cuts at a file boundary and names every file left out", () => {
    const bounded = boundThreadDiff(diff, modified.length + deleted.length + 1);
    assert.strictEqual(bounded.diff, modified + deleted);
    assert.deepStrictEqual(bounded.omittedFiles, ["docs/read me.md", "img/logo.png"]);
  });

  it("names a deleted file by its old path", () => {
    const bounded = boundThreadDiff(diff, modified.length);
    assert.deepStrictEqual(bounded.omittedFiles, [
      "src/gone.ts",
      "docs/read me.md",
      "img/logo.png",
    ]);
  });
});
