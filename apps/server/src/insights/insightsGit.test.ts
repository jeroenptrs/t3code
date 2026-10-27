import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as InsightsGit from "./insightsGit.ts";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 });
    return result.stdout.trim();
  });

/**
 * A bare "remote" with `main` and merge request 7's head, and a checkout cloned before the merge
 * request existed. The merge request adds a source file, a binary file and an agent trailer.
 */
const makeRepositories = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-insights-git-" });
  const remote = `${root}/remote.git`;
  const work = `${root}/work`;
  const checkout = `${root}/checkout`;
  yield* git(root, ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  yield* git(root, ["init", "--quiet", "--initial-branch=main", work]);
  for (const cwd of [work]) {
    yield* git(cwd, ["config", "user.email", "ada@example.com"]);
    yield* git(cwd, ["config", "user.name", "Ada"]);
  }
  yield* fs.writeFileString(`${work}/a.ts`, "export const a = 1;\n");
  yield* git(work, ["add", "."]);
  yield* git(work, ["commit", "--quiet", "-m", "base"]);
  yield* git(work, ["remote", "add", "origin", remote]);
  yield* git(work, ["push", "--quiet", "origin", "main"]);
  yield* git(root, ["clone", "--quiet", remote, checkout]);

  yield* git(work, ["switch", "--quiet", "-c", "feature"]);
  yield* fs.writeFileString(`${work}/b.ts`, "export const b = 2;\nexport const c = 3;\n");
  yield* fs.writeFile(`${work}/logo.png`, new Uint8Array([0, 1, 2, 0, 255, 0]));
  yield* git(work, ["add", "."]);
  yield* git(work, [
    "commit",
    "--quiet",
    "-m",
    "Add b\n\nCo-authored-by: Claude <noreply@anthropic.com>",
  ]);
  const featureSha = yield* git(work, ["rev-parse", "HEAD"]);
  yield* git(work, ["push", "--quiet", "origin", "HEAD:refs/merge-requests/7/head"]);
  return { root, remote, work, checkout, featureSha };
});

const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-insights-git-config-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

describe("mergeRequestRefspecs", () => {
  it("batches 25 refs per fetch into Insights' own namespace", () => {
    const batches = InsightsGit.mergeRequestRefspecs(Array.from({ length: 30 }, (_, i) => i + 1));
    assert.deepStrictEqual(
      batches.map((batch) => batch.length),
      [25, 5],
    );
    assert.strictEqual(batches[0]![0], "+refs/merge-requests/1/head:refs/t3/insights/mr/1");
  });
});

describe("parseNumstatLine", () => {
  it("counts binary files as zero lines", () => {
    assert.deepStrictEqual(InsightsGit.parseNumstatLine("-\t-\tlogo.png"), {
      path: "logo.png",
      additions: 0,
      deletions: 0,
    });
  });
});

it.layer(layerGit, { excludeTestServices: true })("checkout reads", (it) => {
  it.effect("fetches a merge request head and reads its commit facts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repos = yield* makeRepositories;
        const before = yield* InsightsGit.presentCommits({
          cwd: repos.checkout,
          shas: [repos.featureSha],
        });
        assert.isFalse(before.has(repos.featureSha));

        const fetches = yield* InsightsGit.fetchMergeRequestHeads({
          cwd: repos.checkout,
          remote: "origin",
          numbers: [7],
        });
        assert.strictEqual(fetches, 1);
        const after = yield* InsightsGit.presentCommits({
          cwd: repos.checkout,
          shas: [repos.featureSha],
        });
        assert.isTrue(after.has(repos.featureSha));

        const [commit] = yield* InsightsGit.readCommits({
          cwd: repos.checkout,
          shas: [repos.featureSha],
        });
        assert.strictEqual(commit!.sha, repos.featureSha);
        assert.strictEqual(commit!.authorEmail, "ada@example.com");
        assert.strictEqual(commit!.subject, "Add b");
        assert.deepStrictEqual(commit!.coauthors, ["Claude <noreply@anthropic.com>"]);
        assert.deepStrictEqual(
          commit!.files.toSorted((a, b) => a.path.localeCompare(b.path)),
          [
            { path: "b.ts", additions: 2, deletions: 0 },
            { path: "logo.png", additions: 0, deletions: 0 },
          ],
        );

        yield* InsightsGit.pruneRefs({ cwd: repos.checkout });
        const refs = yield* git(repos.checkout, ["for-each-ref", "refs/t3/insights/"]);
        assert.strictEqual(refs, "");
      }),
    ),
  );

  it.effect("lists the remote's branches and names its default branch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repos = yield* makeRepositories;
        yield* git(repos.work, ["push", "--quiet", "origin", "feature"]);
        const listed = yield* InsightsGit.remoteBranches({ cwd: repos.checkout, remote: "origin" });
        assert.strictEqual(listed.head, "main");
        assert.deepStrictEqual(listed.branches.toSorted(), ["feature", "main"]);
      }),
    ),
  );

  it.effect("keeps the patch-ids read before the output limit and drops the cut-off one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repos = yield* makeRepositories;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${repos.work}/big.txt`, "x".repeat(200_000));
        yield* git(repos.work, ["add", "."]);
        yield* git(repos.work, ["commit", "--quiet", "-m", "big"]);
        const bigSha = yield* git(repos.work, ["rev-parse", "HEAD"]);
        yield* git(repos.work, ["push", "--quiet", "origin", "HEAD:refs/merge-requests/7/head"]);
        yield* InsightsGit.fetchMergeRequestHeads({
          cwd: repos.checkout,
          remote: "origin",
          numbers: [7],
        });
        const ids = yield* InsightsGit.readPatchIds({
          cwd: repos.checkout,
          shas: [repos.featureSha, bigSha],
          maxOutputBytes: 64 * 1024,
        });
        assert.isDefined(ids.get(repos.featureSha));
        assert.isUndefined(ids.get(bigSha));
      }),
    ),
  );

  it.effect("gives a rebased commit the same patch-id and reads the branch since a date", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repos = yield* makeRepositories;
        const fs = yield* FileSystem.FileSystem;
        // Someone else lands a change on main, then the feature is rebased onto it and
        // fast-forwarded: the landed sha differs from the merge request's.
        yield* git(repos.work, ["switch", "--quiet", "main"]);
        yield* fs.writeFileString(`${repos.work}/z.ts`, "export const z = 26;\n");
        yield* git(repos.work, ["add", "."]);
        yield* git(repos.work, ["commit", "--quiet", "-m", "direct push"]);
        const directSha = yield* git(repos.work, ["rev-parse", "HEAD"]);
        yield* git(repos.work, ["cherry-pick", repos.featureSha]);
        const rewrittenSha = yield* git(repos.work, ["rev-parse", "HEAD"]);
        yield* git(repos.work, ["push", "--quiet", "origin", "main"]);
        assert.notStrictEqual(rewrittenSha, repos.featureSha);

        yield* InsightsGit.fetchMergeRequestHeads({
          cwd: repos.checkout,
          remote: "origin",
          numbers: [7],
        });
        const ref = yield* InsightsGit.fetchBranch({
          cwd: repos.checkout,
          remote: "origin",
          branch: "main",
        });
        const landed = yield* InsightsGit.readBranchCommits({
          cwd: repos.checkout,
          ref,
          since: "2000-01-01T00:00:00.000Z",
        });
        assert.deepStrictEqual(
          landed.map((commit) => commit.subject),
          ["Add b", "direct push", "base"],
        );
        assert.strictEqual(landed[1]!.sha, directSha);

        const ids = yield* InsightsGit.readPatchIds({
          cwd: repos.checkout,
          shas: [repos.featureSha, rewrittenSha, directSha],
        });
        assert.strictEqual(ids.get(repos.featureSha), ids.get(rewrittenSha));
        assert.notStrictEqual(ids.get(directSha), ids.get(rewrittenSha));
        assert.isDefined(ids.get(directSha));

        const future = yield* InsightsGit.readBranchCommits({
          cwd: repos.checkout,
          ref,
          since: "2099-01-01T00:00:00.000Z",
        });
        assert.deepStrictEqual(future, []);
      }),
    ),
  );
});
