import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationProjectShell,
  ProjectId,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import {
  type ProviderChangeRequest,
  type PullRequestProviderApi,
  PullRequestProviderError,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as InsightsIngestor from "./InsightsIngestor.ts";
import * as InsightsService from "./InsightsService.ts";
import * as InsightsStore from "./InsightsStore.ts";

const GITLAB = SourceControlProviderKind.make("gitlab");
const ADA = { login: "ada", name: "Ada Lovelace", email: "ada@example.com" };
const BOB = { login: "bob", name: "Bob Builder", email: "bob@example.com" };

const git = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "test.git",
      cwd,
      args,
      timeoutMs: 10_000,
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    });
    return result.stdout.trim();
  });

type Person = typeof ADA;

/** A bare remote, a work tree that plays every author, and the T3 project's own checkout. */
const makeRepositories = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-insights-ingest-" });
  const remote = `${root}/remote.git`;
  const work = `${root}/work`;
  const checkout = `${root}/checkout`;
  yield* git(root, ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  yield* git(root, ["init", "--quiet", "--initial-branch=main", work]);
  yield* git(work, ["remote", "add", "origin", remote]);
  let counter = 0;
  const commit = (person: Person, message: string, at: string) =>
    Effect.gen(function* () {
      counter += 1;
      yield* fs.writeFileString(`${work}/file-${counter}.ts`, `export const v${counter} = 1;\n`);
      yield* git(work, ["add", "."]);
      const env = {
        GIT_AUTHOR_NAME: person.name,
        GIT_AUTHOR_EMAIL: person.email,
        GIT_AUTHOR_DATE: at,
        GIT_COMMITTER_NAME: person.name,
        GIT_COMMITTER_EMAIL: person.email,
        GIT_COMMITTER_DATE: at,
      };
      yield* git(work, ["commit", "--quiet", "-m", message], env);
      return yield* git(work, ["rev-parse", "HEAD"]);
    });
  yield* git(work, ["config", "user.name", ADA.name]);
  yield* git(work, ["config", "user.email", ADA.email]);
  // Before the start date, so it is never read.
  yield* commit(ADA, "base", "2025-12-01T09:00:00Z");
  yield* git(work, ["push", "--quiet", "origin", "main"]);
  yield* git(root, ["clone", "--quiet", remote, checkout]);
  return {
    work,
    checkout,
    commit,
    pushMergeRequest: (number: number) =>
      git(work, [
        "push",
        "--quiet",
        "--force",
        "origin",
        `HEAD:refs/merge-requests/${number}/head`,
      ]),
    pushMain: git(work, ["push", "--quiet", "--force", "origin", "HEAD:main"]),
  };
});

interface StubMergeRequest {
  number: number;
  author: Person;
  state: "open" | "merged" | "closed";
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  shas: ReadonlyArray<string>;
  notes?: ReadonlyArray<{ readonly author: Person; readonly at: string }>;
}

interface Stub {
  readonly mergeRequests: StubMergeRequest[];
  readonly calls: string[];
  rateLimited: boolean;
}

const changeRequest = (mr: StubMergeRequest): ProviderChangeRequest => ({
  number: mr.number,
  title: `Change ${mr.number}`,
  url: `https://gitlab.example.com/acme/app/-/merge_requests/${mr.number}`,
  author: { login: mr.author.login, name: mr.author.name, avatarUrl: null },
  headBranch: `feature-${mr.number}`,
  baseBranch: "main",
  state: mr.state,
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  createdAt: mr.createdAt,
  updatedAt: mr.updatedAt,
  mergedAt: mr.mergedAt,
  reviewRequestLogins: [],
  labels: [],
});

const rateLimited = (operation: string) =>
  new PullRequestProviderError({
    provider: GITLAB,
    operation,
    reason: "rate-limited",
    detail: "Too many requests.",
  });

function stubProvider(stub: Stub): PullRequestProviderApi {
  const find = (number: number) => stub.mergeRequests.find((mr) => mr.number === number)!;
  const unused = () => Effect.die("unused");
  return {
    kind: GITLAB,
    capabilities: {
      diff: true,
      comment: true,
      actions: [],
      mergeMethods: ["merge"],
      search: true,
      reactions: false,
      review: { inlineComment: true, reply: true, resolve: true, verdicts: ["comment"] },
      reviewers: { request: false, listCandidates: false },
      edit: { changeRequest: false, comment: false },
    },
    getViewer: () => Effect.succeed("ada"),
    getViewerPermissions: unused,
    listChangeRequests: (input) => {
      stub.calls.push(`list:${input.cursor?.delivered ?? 0}`);
      if (stub.rateLimited) return Effect.fail(rateLimited("listChangeRequests"));
      const sorted = stub.mergeRequests.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const offset = input.cursor?.delivered ?? 0;
      return Effect.succeed({
        items: sorted.slice(offset, offset + input.limit).map(changeRequest),
        truncated: offset + input.limit < sorted.length,
        continues: true,
      });
    },
    getChangeRequest: (input) => {
      stub.calls.push(`detail:${input.number}`);
      const mr = find(input.number);
      return Effect.succeed({
        ...changeRequest(mr),
        headSha: mr.shas.at(-1) ?? null,
        body: "Fixes ACME-12",
        changedFiles: mr.shas.length,
        mergedAt: mr.mergedAt,
        closedAt: null,
        reviewers: [],
        checks: [],
        mergeCapabilities: { merge: true, squash: true, rebase: true },
        viewerPermissions: {
          actions: [],
          comment: true,
          resolve: true,
          verdicts: ["comment"],
          requestReviewers: false,
        },
      });
    },
    getChangeRequestActivity: (input) => {
      stub.calls.push(`activity:${input.number}`);
      const mr = find(input.number);
      return Effect.succeed({
        comments: (mr.notes ?? []).map((note, index) => ({
          id: `note-${index}`,
          kind: "issue-comment" as const,
          author: { login: note.author.login, name: note.author.name, avatarUrl: null },
          body: "Looks good",
          createdAt: note.at,
          url: null,
          path: null,
          reviewState: null,
        })),
        commentCount: mr.notes?.length ?? 0,
        commentsTruncated: false,
        reviewThreads: [],
        commits: mr.shas.map((oid) => ({ oid, messageHeadline: "", committedDate: mr.createdAt })),
      });
    },
    getDiff: unused,
    runAction: unused,
    comment: unused,
    submitReview: unused,
    replyToThread: unused,
    setThreadResolution: unused,
    setReaction: unused,
    listReviewerCandidates: unused,
    setReviewerRequest: unused,
  };
}

const project = (id: string, workspaceRoot: string): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot,
  repositoryIdentity: {
    canonicalKey: `gitlab.example.com/acme/${id}`,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: workspaceRoot },
    provider: SourceControlProviderKind.make("gitlab"),
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

const layerFor = (
  projects: ReadonlyArray<{ readonly id: string; readonly root: string; readonly stub: Stub }>,
) =>
  InsightsService.layer.pipe(
    Layer.provideMerge(InsightsIngestor.layer),
    Layer.provideMerge(InsightsStore.layer),
    Layer.provide(
      Layer.mock(PullRequestService.PullRequestService)({
        providerProjects: () =>
          Effect.succeed(
            projects.map(({ id, root, stub }) => ({
              cursorKey: `gitlab.example.com/acme/${id}`,
              project: project(id, root),
              api: stubProvider(stub),
              repository: `acme/${id}`,
              host: "gitlab.example.com",
              remote: `https://gitlab.example.com/acme/${id}`,
              repositoryKey: null,
            })),
          ),
      }),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-insights-ingest-config-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const PROJECT = ProjectId.make("app");

const commitRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly sha: string;
    readonly contributor_id: string;
    readonly mr_number: number | null;
    readonly landed_at: string | null;
    readonly superseded_by_sha: string | null;
  }>`
    SELECT sha, contributor_id, mr_number, landed_at, superseded_by_sha
    FROM fork_insights_commits ORDER BY authored_at
  `;
});

const contributorFor = (login: string) =>
  Effect.gen(function* () {
    const insights = yield* InsightsService.InsightsService;
    const config = yield* insights.config;
    return config.contributors.find((contributor) => contributor.gitlabLogin === login)!;
  });

const include = (login: string) =>
  Effect.gen(function* () {
    const insights = yield* InsightsService.InsightsService;
    const contributor = yield* contributorFor(login);
    yield* insights.updateContributor(
      { contributorId: contributor.contributorId, status: "included" },
      null,
    );
    return contributor.contributorId;
  });

const enable = Effect.gen(function* () {
  const insights = yield* InsightsService.InsightsService;
  yield* insights.updateSettings({ startDate: "2026-01-01" }, null);
  yield* insights.setProjectEnabled({ projectId: PROJECT, enabled: true }, null);
});

describe("branchMatchesPattern", () => {
  it("matches one path segment with * and any depth with **", () => {
    assert.isTrue(InsightsIngestor.branchMatchesPattern("release/1.2", "release/*"));
    assert.isFalse(InsightsIngestor.branchMatchesPattern("release/1.2/hotfix", "release/*"));
    assert.isTrue(InsightsIngestor.branchMatchesPattern("release/1.2/hotfix", "release/**"));
    assert.isFalse(InsightsIngestor.branchMatchesPattern("prerelease/1.2", "release/*"));
  });
});

const tick = Effect.gen(function* () {
  yield* (yield* InsightsIngestor.InsightsIngestor).runDueWork;
});

it.layer(layerGit, { excludeTestServices: true })("Insights ingestion", (it) => {
  it.effect("stores nothing for pending contributors and reads their history once included", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repos = yield* makeRepositories;
        yield* git(repos.work, ["switch", "--quiet", "-c", "feature-1"]);
        const sha = yield* repos.commit(ADA, "ACME-7 add a thing", "2026-02-02T10:00:00Z");
        yield* repos.pushMergeRequest(1);
        const stub: Stub = {
          mergeRequests: [
            {
              number: 1,
              author: ADA,
              state: "open",
              createdAt: "2026-02-02T10:00:00Z",
              updatedAt: "2026-02-02T11:00:00Z",
              mergedAt: null,
              shas: [sha],
              notes: [{ author: BOB, at: "2026-02-02T12:00:00Z" }],
            },
          ],
          calls: [],
          rateLimited: false,
        };
        yield* Effect.gen(function* () {
          yield* enable;
          yield* tick;
          const insights = yield* InsightsService.InsightsService;
          const pending = yield* insights.config;
          assert.deepStrictEqual(
            pending.contributors.map((contributor) => [
              contributor.gitlabLogin,
              contributor.status,
            ]),
            [
              ["ada", "pending"],
              ["bob", "pending"],
            ],
          );
          // The commit email joined Ada's login by name, so she is listed once.
          assert.deepStrictEqual(
            pending.contributors.find((contributor) => contributor.gitlabLogin === "ada")!.emails,
            ["ada@example.com"],
          );
          assert.deepStrictEqual(yield* commitRows, []);
          assert.isNotNull(pending.projects[0]!.syncedThrough);

          const ada = yield* include("ada");
          yield* tick;
          const rows = yield* commitRows;
          assert.deepStrictEqual(
            rows.map((row) => [row.sha, row.contributor_id, row.mr_number]),
            [[sha, ada, 1]],
          );
          const overview = yield* insights.overview({ from: "2026-02-02", to: "2026-02-08" });
          assert.strictEqual(overview.contributors.length, 1);
          assert.strictEqual(overview.contributors[0]!.commits, 1);
          assert.strictEqual(overview.contributors[0]!.medianFirstReviewHours, 2);

          // Excluding deletes what was stored for her.
          yield* insights.updateContributor({ contributorId: ada, status: "excluded" }, null);
          assert.deepStrictEqual(yield* commitRows, []);
        }).pipe(Effect.provide(layerFor([{ id: "app", root: repos.checkout, stub }])));
      }),
    ),
  );

  it.effect("does not store a merge request's merge commits as pushed work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repos = yield* makeRepositories;
        yield* git(repos.work, ["switch", "--quiet", "-c", "feature-1"]);
        const sha = yield* repos.commit(ADA, "the change", "2026-02-02T10:00:00Z");
        yield* git(repos.work, ["switch", "--quiet", "main"]);
        yield* repos.commit(ADA, "someone else's change", "2026-02-03T10:00:00Z");
        yield* git(repos.work, ["switch", "--quiet", "feature-1"]);
        yield* git(repos.work, ["merge", "--quiet", "--no-ff", "-m", "Merge main", "main"], {
          GIT_AUTHOR_DATE: "2026-02-04T10:00:00Z",
          GIT_COMMITTER_DATE: "2026-02-04T10:00:00Z",
        });
        const mergeSha = yield* git(repos.work, ["rev-parse", "HEAD"]);
        yield* repos.pushMergeRequest(1);
        const stub: Stub = {
          mergeRequests: [
            {
              number: 1,
              author: ADA,
              state: "open",
              createdAt: "2026-02-02T10:00:00Z",
              updatedAt: "2026-02-04T11:00:00Z",
              mergedAt: null,
              shas: [sha, mergeSha],
            },
          ],
          calls: [],
          rateLimited: false,
        };
        yield* Effect.gen(function* () {
          yield* enable;
          yield* tick;
          const ada = yield* include("ada");
          yield* tick;
          assert.deepStrictEqual(
            (yield* commitRows).map((row) => [row.sha, row.contributor_id, row.mr_number]),
            [[sha, ada, 1]],
          );
        }).pipe(Effect.provide(layerFor([{ id: "app", root: repos.checkout, stub }])));
      }),
    ),
  );

  it.effect("moves the cursor only after a complete walk and stops at the budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repos = yield* makeRepositories;
        const stub: Stub = {
          mergeRequests: [1, 2].map((number) => ({
            number,
            author: ADA,
            state: "open" as const,
            createdAt: `2026-02-0${number}T10:00:00Z`,
            updatedAt: `2026-02-0${number}T10:00:00Z`,
            mergedAt: null,
            shas: [],
          })),
          calls: [],
          rateLimited: false,
        };
        yield* Effect.gen(function* () {
          yield* enable;
          const insights = yield* InsightsService.InsightsService;
          yield* insights.updateSettings({ requestBudgetPerTick: 3 }, null);
          yield* tick;
          assert.deepStrictEqual(stub.calls, ["list:0", "detail:2", "activity:2"]);
          assert.isNull((yield* insights.config).projects[0]!.syncedThrough);

          stub.calls.length = 0;
          yield* tick;
          assert.deepStrictEqual(stub.calls, ["list:1", "detail:1", "activity:1"]);
          // The newest merge request seen, less the overlap GitLab's second precision needs.
          assert.strictEqual(
            (yield* insights.config).projects[0]!.syncedThrough,
            "2026-02-02T09:59:00.000Z",
          );
        }).pipe(Effect.provide(layerFor([{ id: "app", root: repos.checkout, stub }])));
      }),
    ),
  );

  it.effect(
    "lands squash merges, rewritten commits and direct pushes from the default branch",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repos = yield* makeRepositories;
          // Merge request 1: squash merged.
          yield* git(repos.work, ["switch", "--quiet", "-c", "feature-1", "main"]);
          const squashed = yield* repos.commit(ADA, "part one", "2026-02-02T10:00:00Z");
          yield* repos.pushMergeRequest(1);
          // Merge request 2: open, but its change reached main rebased onto other work.
          yield* git(repos.work, ["switch", "--quiet", "-c", "feature-2", "main"]);
          const original = yield* repos.commit(ADA, "part two", "2026-02-03T10:00:00Z");
          yield* repos.pushMergeRequest(2);

          yield* git(repos.work, ["switch", "--quiet", "main"]);
          yield* git(repos.work, ["merge", "--quiet", "--squash", "feature-1"]);
          yield* git(repos.work, ["commit", "--quiet", "-m", "Change 1"], {
            GIT_AUTHOR_NAME: ADA.name,
            GIT_AUTHOR_EMAIL: ADA.email,
            GIT_AUTHOR_DATE: "2026-02-04T10:00:00Z",
            GIT_COMMITTER_NAME: ADA.name,
            GIT_COMMITTER_EMAIL: ADA.email,
            GIT_COMMITTER_DATE: "2026-02-04T10:00:00Z",
          });
          const direct = yield* repos.commit(ADA, "hotfix", "2026-02-05T10:00:00Z");
          yield* git(repos.work, ["cherry-pick", original], {
            GIT_COMMITTER_DATE: "2026-02-06T10:00:00Z",
          });
          const rewritten = yield* git(repos.work, ["rev-parse", "HEAD"]);
          yield* repos.pushMain;

          const stub: Stub = {
            mergeRequests: [
              {
                number: 1,
                author: ADA,
                state: "merged",
                createdAt: "2026-02-02T10:00:00Z",
                updatedAt: "2026-02-04T10:00:30Z",
                mergedAt: "2026-02-04T10:00:30Z",
                shas: [squashed],
              },
              {
                number: 2,
                author: ADA,
                state: "open",
                createdAt: "2026-02-03T10:00:00Z",
                updatedAt: "2026-02-03T10:00:00Z",
                mergedAt: null,
                shas: [original],
              },
            ],
            calls: [],
            rateLimited: false,
          };
          yield* Effect.gen(function* () {
            yield* enable;
            yield* tick;
            yield* include("ada");
            yield* tick;
            const rows = yield* commitRows;
            assert.deepStrictEqual(
              rows.map((row) => [row.sha, row.mr_number, row.landed_at]),
              [
                [squashed, 1, "2026-02-04T10:00:30.000Z"],
                [original, 2, "2026-02-06T10:00:00.000Z"],
                [direct, null, "2026-02-05T10:00:00.000Z"],
              ],
            );
            assert.isFalse(rows.some((row) => row.sha === rewritten));
          }).pipe(Effect.provide(layerFor([{ id: "app", root: repos.checkout, stub }])));
        }),
      ),
  );

  it.effect("supersedes a merge request's commits that a rebase replaced", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repos = yield* makeRepositories;
        yield* git(repos.work, ["switch", "--quiet", "-c", "feature-1"]);
        const before = yield* repos.commit(ADA, "the change", "2026-02-02T10:00:00Z");
        yield* repos.pushMergeRequest(1);
        const mergeRequest: StubMergeRequest = {
          number: 1,
          author: ADA,
          state: "open",
          createdAt: "2026-02-02T10:00:00Z",
          updatedAt: "2026-02-02T10:00:00Z",
          mergedAt: null,
          shas: [before],
        };
        const stub: Stub = { mergeRequests: [mergeRequest], calls: [], rateLimited: false };
        yield* Effect.gen(function* () {
          yield* enable;
          yield* tick;
          yield* include("ada");
          yield* tick;

          yield* git(repos.work, ["commit", "--quiet", "--amend", "--no-edit"], {
            GIT_COMMITTER_DATE: "2026-02-03T10:00:00Z",
          });
          const after = yield* git(repos.work, ["rev-parse", "HEAD"]);
          yield* repos.pushMergeRequest(1);
          mergeRequest.shas = [after];
          mergeRequest.updatedAt = "2026-02-03T10:00:00Z";
          const insights = yield* InsightsService.InsightsService;
          yield* insights.rescanProject({ projectId: PROJECT });
          yield* tick;

          const rows = yield* commitRows;
          assert.deepStrictEqual(
            rows
              .map((row) => [row.sha, row.superseded_by_sha])
              .toSorted(([a], [b]) => (a === before ? -1 : b === before ? 1 : 0)),
            [
              [before, after],
              [after, null],
            ],
          );
          const overview = yield* insights.overview({ from: "2026-02-02", to: "2026-02-08" });
          assert.strictEqual(overview.contributors[0]!.commits, 1);
        }).pipe(Effect.provide(layerFor([{ id: "app", root: repos.checkout, stub }])));
      }),
    ),
  );

  it.effect("pauses the whole host when the provider is rate limited", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repos = yield* makeRepositories;
        const limited: Stub = { mergeRequests: [], calls: [], rateLimited: true };
        const other: Stub = { mergeRequests: [], calls: [], rateLimited: false };
        yield* Effect.gen(function* () {
          const insights = yield* InsightsService.InsightsService;
          yield* insights.updateSettings({ startDate: "2026-01-01" }, null);
          yield* insights.setProjectEnabled({ projectId: PROJECT, enabled: true }, null);
          yield* insights.setProjectEnabled(
            { projectId: ProjectId.make("other"), enabled: true },
            null,
          );
          yield* tick;
          assert.deepStrictEqual(limited.calls, ["list:0"]);
          assert.deepStrictEqual(other.calls, []);
          const config = yield* insights.config;
          assert.isTrue(config.projects.every((project) => project.lastError === null));

          limited.rateLimited = false;
          yield* tick;
          assert.deepStrictEqual(other.calls, ["list:0"]);
        }).pipe(
          Effect.provide(
            layerFor([
              { id: "app", root: repos.checkout, stub: limited },
              { id: "other", root: repos.checkout, stub: other },
            ]),
          ),
        );
      }),
    ),
  );

  it.effect("disabling a project deletes its rows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repos = yield* makeRepositories;
        yield* git(repos.work, ["switch", "--quiet", "-c", "feature-1"]);
        const sha = yield* repos.commit(ADA, "work", "2026-02-02T10:00:00Z");
        yield* repos.pushMergeRequest(1);
        const stub: Stub = {
          mergeRequests: [
            {
              number: 1,
              author: ADA,
              state: "open",
              createdAt: "2026-02-02T10:00:00Z",
              updatedAt: "2026-02-02T10:00:00Z",
              mergedAt: null,
              shas: [sha],
            },
          ],
          calls: [],
          rateLimited: false,
        };
        yield* Effect.gen(function* () {
          yield* enable;
          yield* tick;
          yield* include("ada");
          yield* tick;
          assert.strictEqual((yield* commitRows).length, 1);
          const insights = yield* InsightsService.InsightsService;
          yield* insights.setProjectEnabled({ projectId: PROJECT, enabled: false }, null);
          assert.deepStrictEqual(yield* commitRows, []);
          assert.strictEqual(yield* git(repos.checkout, ["for-each-ref", "refs/t3/insights/"]), "");
        }).pipe(Effect.provide(layerFor([{ id: "app", root: repos.checkout, stub }])));
      }),
    ),
  );
});
