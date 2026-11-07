import { assert, describe, it } from "@effect/vitest";
import {
  ScheduledTask,
  ScheduledTaskError,
  ScheduledTaskId,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { parseMergeRequestsPage, parsePipelinesPage } from "./gitlabProjectsClient.ts";
import * as GitLabProjectsPoller from "./gitlabProjectsPoller.ts";
import * as TriggerSources from "./TriggerSources.ts";

const HOST = "gitlab.acme.dev";

// Trimmed from `glab api projects/acme%2Fapp/merge_requests`, with GitLab's extra fields kept.
const MERGE_REQUESTS = JSON.stringify([
  {
    id: 3101,
    iid: 12,
    project_id: 77,
    title: "Add SSO login ",
    description: "Closes #4",
    state: "opened",
    created_at: "2026-11-04T08:00:00.000Z",
    updated_at: "2026-11-05T09:30:00.123+01:00",
    merged_at: null,
    closed_at: null,
    target_branch: "main",
    source_branch: "feature/sso",
    author: { id: 5, username: "ada", name: "Ada", state: "active" },
    draft: true,
    merge_status: "checking",
    detailed_merge_status: "checking",
    sha: "0f1e2d",
    references: { short: "!12", relative: "!12", full: "acme/app!12" },
    web_url: `https://${HOST}/acme/app/-/merge_requests/12`,
  },
  {
    id: 3102,
    iid: 13,
    project_id: 78,
    title: "Bump deps",
    state: "merged",
    created_at: "2026-11-01T08:00:00.000Z",
    updated_at: "2026-11-05T09:40:00.000Z",
    merged_at: "2026-11-05T09:40:00.000Z",
    closed_at: null,
    target_branch: "main",
    source_branch: "deps",
    author: null,
    references: { short: "!13", relative: "acme/api!13", full: "acme/api!13" },
    web_url: `https://${HOST}/acme/api/-/merge_requests/13`,
  },
]);

// Trimmed from `glab api projects/acme%2Fapp/pipelines`.
const PIPELINES = JSON.stringify([
  {
    id: 901,
    iid: 55,
    project_id: 77,
    sha: "0f1e2d",
    ref: "refs/merge-requests/12/head",
    status: "failed",
    source: "merge_request_event",
    created_at: "2026-11-05T09:00:00.000Z",
    updated_at: "2026-11-05T09:45:00.000Z",
    web_url: `https://${HOST}/acme/app/-/pipelines/901`,
  },
]);

describe("GitLab projects client", () => {
  it("reads merge requests and pipelines from GitLab's list responses", () => {
    const project = Result.getOrThrow(parseMergeRequestsPage(MERGE_REQUESTS, HOST, "acme/app"));
    assert.deepEqual(project[0], {
      key: {
        host: HOST,
        repository: "acme/app",
        number: 12,
        url: `https://${HOST}/acme/app/-/merge_requests/12`,
      },
      snapshot: {
        state: "open",
        title: "Add SSO login",
        headBranch: "feature/sso",
        baseBranch: "main",
        isDraft: true,
        updatedAt: "2026-11-05T08:30:00.123Z",
        syncedAt: "2026-11-05T08:30:00.123Z",
        closedAt: null,
        mergedAt: null,
        author: { login: "ada", name: null, avatarUrl: null },
      },
    });
    // A group's merge requests name their project in their reference.
    const group = Result.getOrThrow(parseMergeRequestsPage(MERGE_REQUESTS, HOST, null));
    assert.deepEqual(
      group.map((entry) => [entry.key.repository, entry.snapshot.state, entry.snapshot.author]),
      [
        ["acme/app", "open", { login: "ada", name: null, avatarUrl: null }],
        ["acme/api", "merged", null],
      ],
    );
    assert.deepEqual(Result.getOrThrow(parsePipelinesPage(PIPELINES, "acme/app")), [
      {
        id: "901",
        repository: "acme/app",
        status: "failed",
        ref: "refs/merge-requests/12/head",
        url: `https://${HOST}/acme/app/-/pipelines/901`,
        updatedAt: "2026-11-05T09:45:00.000Z",
      },
    ]);
    assert.isTrue(Result.isFailure(parsePipelinesPage('{"message":"404 Not Found"}', "acme/app")));
  });
});

const decodeTask = Schema.decodeUnknownSync(ScheduledTask);
const task = (schedule: Record<string, unknown>) =>
  decodeTask({
    id: "task:projects",
    title: "Merge requests",
    prompt: "Review {{event.url}}",
    enabled: true,
    schedule: { type: "gitlab_projects", host: HOST, everyMs: 900_000, ...schedule },
    projectId: "project-1",
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "auto",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  });

const output = (stdout: string, stderr = "") => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr,
  stdoutTruncated: false,
  stderrTruncated: false,
});

it.effect(
  "polls as the host's glab login, checked once per host and again after an unauthorized read",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-05T10:00:00.000Z"));
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const revoked = yield* Ref.make(false);
      const unauthorized = (cwd: string) =>
        new GitLabCli.GitLabCliCommandError({
          operation: "execute",
          command: "glab",
          cwd,
          cause: new VcsProcessExitError({
            operation: "GitLabCli.execute",
            command: "glab",
            cwd,
            exitCode: 1,
            detail: "glab: 401 Unauthorized (HTTP 401)",
          }),
        });
      const gitlab = Layer.mock(GitLabCli.GitLabCli)({
        execute: (input) =>
          Ref.update(calls, (all) => [...all, `${input.host} ${input.args.join(" ")}`]).pipe(
            Effect.andThen(Ref.get(revoked)),
            Effect.flatMap((isRevoked) => {
              const [command, path = ""] = input.args;
              if (command === "auth") {
                return input.host === HOST && !isRevoked
                  ? Effect.succeed(output("", `${HOST}\n  ✓ Logged in to ${HOST} as svc-bot`))
                  : Effect.succeed(output("", `${input.host}\n  x No token found`));
              }
              if (isRevoked) return Effect.fail(unauthorized(input.cwd));
              if (path.includes("/pipelines")) return Effect.succeed(output(PIPELINES));
              return Effect.succeed(output(MERGE_REQUESTS));
            }),
          ),
      });
      const projects = Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () =>
          Effect.succeedSome({ workspaceRoot: "/home/user/acme-app" } as ProjectStore.ProjectRow),
      });
      yield* Effect.gen(function* () {
        const poller = yield* GitLabProjectsPoller.make;
        const take = Ref.getAndSet(calls, []);

        // The seed reads open merge requests only and starts the pipeline mark at the poll.
        yield* poller.poll(task({ projects: ["acme/app"] }));
        assert.deepEqual(yield* take, [
          `${HOST} auth status --hostname ${HOST}`,
          `${HOST} api projects/acme%2Fapp/merge_requests?order_by=updated_at&sort=asc&state=opened&with_merge_status_recheck=false&per_page=100&page=1`,
        ]);
        // The login was confirmed by the first poll, so the second reads straight away.
        yield* poller.poll(task({ projects: ["acme/app"] }));
        assert.deepEqual(yield* take, [
          `${HOST} api projects/acme%2Fapp/merge_requests?order_by=updated_at&sort=asc&updated_after=2026-11-05T10%3A00%3A00.000Z&with_merge_status_recheck=false&per_page=100&page=1`,
          `${HOST} api projects/acme%2Fapp/pipelines?order_by=updated_at&sort=asc&updated_after=2026-11-05T10%3A00%3A00.000Z&per_page=100&page=1`,
        ]);
        const sources = yield* TriggerSources.TriggerSources;
        assert.deepEqual(
          (yield* sources.gitLabProjectsMarker(ScheduledTaskId.make("task:projects")))?.marks,
          {
            "merge_requests:acme/app": "2026-11-05T10:00:00.000Z",
            "pipelines:acme/app": "2026-11-05T10:00:00.000Z",
          },
        );

        // Firing the current set also reads every open merge request, and keeps the marks.
        yield* poller.poll(task({ projects: ["acme/app"] }), { fireCurrent: true });
        assert.deepEqual(
          (yield* take).map((call) => call.split("&with")[0]),
          [
            `${HOST} api projects/acme%2Fapp/merge_requests?order_by=updated_at&sort=asc&updated_after=2026-11-05T10%3A00%3A00.000Z`,
            `${HOST} api projects/acme%2Fapp/pipelines?order_by=updated_at&sort=asc&updated_after=2026-11-05T10%3A00%3A00.000Z&per_page=100&page=1`,
            `${HOST} api projects/acme%2Fapp/merge_requests?order_by=updated_at&sort=asc&state=opened`,
          ],
        );

        // A group reads its merge requests, then pipelines per project they name.
        yield* poller.poll(task({ projects: [], group: "acme" }));
        yield* poller.poll(task({ projects: [], group: "acme" }));
        const group = (yield* take).slice(1).map((call) => call.split("?")[0]);
        assert.deepEqual(group, [
          `${HOST} api groups/acme/merge_requests`,
          `${HOST} api projects/acme%2Fapp/pipelines`,
          `${HOST} api projects/acme%2Fapi/pipelines`,
        ]);

        // A host without a glab login is never read.
        const failure = yield* poller
          .poll(task({ host: "gitlab.other.dev", projects: ["acme/app"] }))
          .pipe(Effect.flip);
        assert.instanceOf(failure, ScheduledTaskError);
        assert.equal(
          failure.message,
          "GitLab has no sign-in on this server for gitlab.other.dev. Run `glab auth login --hostname gitlab.other.dev` where T3 Code runs.",
        );
        assert.deepEqual(yield* take, ["gitlab.other.dev auth status --hostname gitlab.other.dev"]);

        // A revoked login fails a read with 401; the next poll checks again and says so.
        yield* Ref.set(revoked, true);
        yield* poller.poll(task({ projects: ["acme/app"] })).pipe(Effect.flip);
        assert.deepEqual(
          (yield* take).map((call) => call.split("?")[0]),
          [`${HOST} api projects/acme%2Fapp/merge_requests`],
        );
        const signedOut = yield* poller.poll(task({ projects: ["acme/app"] })).pipe(Effect.flip);
        assert.equal(
          signedOut.message,
          `GitLab has no sign-in on this server for ${HOST}. Run \`glab auth login --hostname ${HOST}\` where T3 Code runs.`,
        );
        assert.deepEqual(yield* take, [`${HOST} auth status --hostname ${HOST}`]);
      }).pipe(Effect.provide(Layer.mergeAll(gitlab, projects, TriggerSources.layer)));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
