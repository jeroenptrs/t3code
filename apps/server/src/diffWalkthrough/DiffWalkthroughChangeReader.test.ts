import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointRef,
  type DiffWalkthroughPullRequestTarget,
  ProjectId,
  type PullRequestDetail,
  PullRequestOperationError,
  type PullRequestDiffInput,
  type PullRequestDiffResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import { CheckpointRefUnavailableError } from "../checkpointing/Errors.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as DiffWalkthroughChangeReader from "./DiffWalkthroughChangeReader.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 });
    return result.stdout.trim();
  });

const tenLines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);

/** A base commit, and a head that edits line 3 of a.txt, removes its line 8, and deletes b.txt. */
const makeRepository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-walkthrough-change-" });
  yield* git(workspace, ["init", "--quiet", "--initial-branch=main"]);
  yield* git(workspace, ["config", "user.email", "test@example.com"]);
  yield* git(workspace, ["config", "user.name", "Test"]);
  yield* fs.writeFileString(`${workspace}/a.txt`, `${tenLines.join("\n")}\n`);
  yield* fs.writeFileString(`${workspace}/b.txt`, "x\n");
  yield* git(workspace, ["add", "."]);
  yield* git(workspace, ["commit", "--quiet", "-m", "base"]);
  const baseSha = yield* git(workspace, ["rev-parse", "HEAD"]);
  const edited = tenLines.map((line, index) => (index === 2 ? "three" : line));
  edited.splice(7, 1);
  yield* fs.writeFileString(`${workspace}/a.txt`, `${edited.join("\n")}\n`);
  yield* git(workspace, ["rm", "--quiet", "b.txt"]);
  yield* git(workspace, ["commit", "--quiet", "-am", "head"]);
  const headSha = yield* git(workspace, ["rev-parse", "HEAD"]);
  return { workspace, baseSha, headSha };
});

const expectedHunks = new Map([
  [
    "a.txt",
    {
      new: [{ start: 3, end: 3 }],
      old: [
        { start: 3, end: 3 },
        { start: 8, end: 8 },
      ],
    },
  ],
  ["b.txt", { new: [], old: [{ start: 1, end: 1 }] }],
]);

interface Stubs {
  readonly workspace?: string;
  readonly resolveTurnRange?: CheckpointDiffQuery.CheckpointDiffQuery["Service"]["resolveTurnRange"];
  readonly headSha?: string;
  readonly diff?: (input: PullRequestDiffInput) => PullRequestDiffResult;
  readonly diffFails?: boolean;
}

const readerWith = (stubs: Stubs) =>
  DiffWalkthroughChangeReader.DiffWalkthroughChangeReader.pipe(
    Effect.provide(
      DiffWalkthroughChangeReader.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectService.ProjectService)({
              getShell: () =>
                Effect.succeed(
                  stubs.workspace === undefined
                    ? Option.none()
                    : Option.some({ workspaceRoot: stubs.workspace } as never),
                ),
            }),
            Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({
              resolveTurnRange:
                stubs.resolveTurnRange ?? (() => Effect.die("not resolved in this test")),
            }),
            Layer.mock(PullRequestService.PullRequestService)({
              detail: () =>
                Effect.succeed({ headSha: stubs.headSha } as unknown as PullRequestDetail),
              diff: (input) =>
                stubs.diffFails === true
                  ? Effect.fail(
                      new PullRequestOperationError({ operation: "diff", detail: "Host is down." }),
                    )
                  : Effect.succeed(stubs.diff!(input)),
            }),
          ),
        ),
      ),
    ),
  );

const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-walkthrough-change-git-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layerGit, { excludeTestServices: true })("local changes", (it) => {
  it.effect("reads a branch range's changed lines from the project's repository", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* makeRepository;
        const reader = yield* readerWith({ workspace: repository.workspace });
        const read = yield* reader.read({
          kind: "branch-range",
          projectId: PROJECT_ID,
          branch: "main",
          baseSha: repository.baseSha,
          headSha: repository.headSha,
        });
        assert.isTrue(read.held);
        if (!read.held) return;
        assert.deepStrictEqual(read.change.files, ["a.txt", "b.txt"]);
        assert.deepStrictEqual(read.change.hunks, expectedHunks);
        assert.strictEqual(read.withheld.size, 0);

        // A revision that is not a SHA never reaches git as an argument.
        const refused = yield* reader.read({
          kind: "branch-range",
          projectId: PROJECT_ID,
          branch: "main",
          baseSha: "--output=/tmp/x",
          headSha: repository.headSha,
        });
        assert.isFalse(refused.held);
      }),
    ),
  );

  it.effect("reads a thread diff between its two checkpoint refs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* makeRepository;
        const from = CheckpointRef.make("refs/t3/checkpoints/test/0");
        const to = CheckpointRef.make("refs/t3/checkpoints/test/1");
        yield* git(repository.workspace, ["update-ref", from, repository.baseSha]);
        yield* git(repository.workspace, ["update-ref", to, repository.headSha]);
        const reader = yield* readerWith({
          resolveTurnRange: () =>
            Effect.succeed({
              cwd: repository.workspace,
              fromCheckpointRef: from,
              toCheckpointRef: to,
            }),
        });
        const read = yield* reader.read({
          kind: "thread-diff",
          threadId: THREAD_ID,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
        assert.isTrue(read.held);
        if (read.held) assert.deepStrictEqual(read.change.hunks, expectedHunks);
      }),
    ),
  );

  it.effect("holds an empty turn range to nothing and stores unchecked when a ref is missing", () =>
    Effect.gen(function* () {
      const reader = yield* readerWith({
        resolveTurnRange: (input) =>
          Effect.fail(
            new CheckpointRefUnavailableError({
              operation: "CheckpointDiffQuery.getTurnDiff",
              threadId: input.threadId,
              turnCount: input.toTurnCount,
              checkpoint: "to",
            }),
          ),
      });
      const empty = yield* reader.read({
        kind: "thread-diff",
        threadId: THREAD_ID,
        fromTurnCount: 2,
        toTurnCount: 2,
      });
      assert.isTrue(empty.held);
      if (empty.held) assert.deepStrictEqual(empty.change.files, []);

      const missing = yield* reader.read({
        kind: "thread-diff",
        threadId: THREAD_ID,
        fromTurnCount: 0,
        toTurnCount: 3,
      });
      assert.deepStrictEqual(missing, {
        held: false,
        reason:
          "Checkpoint unavailable for thread thread-1 turn 3: Checkpoint ref is unavailable for turn 3.",
      });
    }),
  );
});

// The pull request reader never runs git, but the reader is built with it.
it.layer(layerGit)("pull request changes", (it) => {
  const target: DiffWalkthroughPullRequestTarget = {
    kind: "pull-request",
    projectId: PROJECT_ID,
    host: "github.com",
    repository: "acme/app",
    number: 7,
    headSha: "abc123",
  };

  const slices: Record<string, PullRequestDiffResult> = {
    first: {
      patch: [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -8,7 +8,8 @@ context",
        " keep",
        "+added",
        "",
      ].join("\n"),
      truncated: false,
      nextCursor: "2",
    },
    "2": {
      patch: [
        "diff --git a/assets/logo.png b/assets/logo.png",
        "--- a/assets/logo.png",
        "+++ b/assets/logo.png",
        "diff --git a/src/huge.ts b/src/huge.ts",
        "--- a/src/huge.ts",
        "+++ b/src/huge.ts",
        "",
      ].join("\n"),
      truncated: true,
      nextCursor: null,
      omittedFileStats: [{ path: "src/huge.ts", additions: 4000, deletions: 10 }],
    },
  };

  it.effect("pages the served diff until whole and keeps files whose lines were withheld", () =>
    Effect.gen(function* () {
      const cursors: Array<string | undefined> = [];
      const reader = yield* readerWith({
        headSha: "ABC123",
        diff: (input) => {
          cursors.push(input.cursor);
          return slices[input.cursor ?? "first"]!;
        },
      });
      const read = yield* reader.read(target);
      assert.deepStrictEqual(cursors, [undefined, "2"]);
      assert.isTrue(read.held);
      if (!read.held) return;
      assert.deepStrictEqual(read.change.files, ["src/a.ts", "assets/logo.png", "src/huge.ts"]);
      // The host's hunks carry its context lines.
      assert.deepStrictEqual(read.change.hunks.get("src/a.ts"), {
        new: [{ start: 8, end: 15 }],
        old: [{ start: 8, end: 14 }],
      });
      assert.deepStrictEqual([...read.withheld].toSorted(), ["assets/logo.png", "src/huge.ts"]);
    }),
  );

  it.effect("does not check notes against another head's diff, or when the host fails", () =>
    Effect.gen(function* () {
      const moved = yield* (yield* readerWith({
        headSha: "def4567890",
        diff: () => assert.fail("another head's diff is not read"),
      })).read(target);
      assert.deepStrictEqual(moved, {
        held: false,
        reason:
          "The pull request's head is now def4567890, not abc123, so its diff is another revision.",
      });

      const down = yield* (yield* readerWith({ headSha: "abc123", diffFails: true })).read(target);
      assert.deepStrictEqual(down, {
        held: false,
        reason: "Could not read the pull request's diff from the host.",
      });
    }),
  );
});
