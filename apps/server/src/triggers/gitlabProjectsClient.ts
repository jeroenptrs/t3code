import { type ThreadPullRequestSnapshot, VcsProcessExitError } from "@t3tools/contracts";
import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { GitLabPipelineState, PullRequestTriggerKey } from "./gitlabTriggerSource.ts";

const PAGE_SIZE = 100;
const MAX_PAGES = 5;

const RawMergeRequest = Schema.Struct({
  iid: Schema.Int,
  project_id: Schema.Int,
  title: Schema.String,
  web_url: Schema.String,
  state: Schema.String,
  draft: Schema.optional(Schema.Boolean),
  source_branch: Schema.String,
  target_branch: Schema.String,
  updated_at: Schema.String,
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(Schema.Struct({ username: Schema.String }))),
  references: Schema.optional(Schema.Struct({ full: Schema.optional(Schema.String) })),
});

const RawPipeline = Schema.Struct({
  id: Schema.Int,
  ref: Schema.String,
  status: Schema.String,
  web_url: Schema.String,
  updated_at: Schema.String,
});

const decodeMergeRequests = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Array(RawMergeRequest)),
);
const decodePipelines = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Array(RawPipeline)),
);

export interface PolledMergeRequest {
  readonly key: PullRequestTriggerKey;
  readonly snapshot: ThreadPullRequestSnapshot;
}

const iso = (value: string) =>
  Option.match(DateTime.make(value), { onNone: () => value, onSome: DateTime.formatIso });

const stateOf = (raw: typeof RawMergeRequest.Type): ThreadPullRequestSnapshot["state"] => {
  if (raw.merged_at != null || raw.state === "merged") return "merged";
  return raw.state === "closed" ? "closed" : "open";
};

/**
 * One page of `GET .../merge_requests`, as the snapshots linked merge requests are diffed with.
 * A group's merge requests name their project in `references.full`, such as `acme/app!12`.
 */
export function parseMergeRequestsPage(
  raw: string,
  host: string,
  repository: string | null,
): Result.Result<ReadonlyArray<PolledMergeRequest>, Schema.SchemaError> {
  return Result.map(decodeMergeRequests(raw), (items) =>
    items.map((item) => {
      const updatedAt = iso(item.updated_at);
      return {
        key: {
          host,
          repository: repository ?? item.references?.full?.replace(/!\d+$/, "") ?? "",
          number: item.iid,
          url: item.web_url,
        },
        snapshot: {
          state: stateOf(item),
          title: item.title.trim() || `!${item.iid}`,
          headBranch: item.source_branch,
          baseBranch: item.target_branch,
          isDraft: item.draft === true,
          // The sync time is the update time, so an unchanged merge request stores no change.
          updatedAt,
          syncedAt: updatedAt,
          closedAt: item.closed_at ?? null,
          mergedAt: item.merged_at ?? null,
          author:
            item.author == null
              ? null
              : { login: item.author.username, name: null, avatarUrl: null },
        },
      };
    }),
  );
}

/** One page of `GET projects/:id/pipelines`. */
export function parsePipelinesPage(
  raw: string,
  repository: string,
): Result.Result<ReadonlyArray<GitLabPipelineState>, Schema.SchemaError> {
  return Result.map(decodePipelines(raw), (items) =>
    items.map((item) => ({
      id: String(item.id),
      repository,
      status: item.status,
      ref: item.ref,
      url: item.web_url,
      updatedAt: iso(item.updated_at),
    })),
  );
}

export class GitLabProjectsReadError extends Schema.TaggedError<GitLabProjectsReadError>()(
  "GitLabProjectsReadError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const LOGGED_IN = /Logged in to \S+ as/i;
const UNAUTHORIZED = /\b40[13]\b|unauthorized|forbidden/i;
const isExitError = Schema.is(VcsProcessExitError);

/** glab reports an API 401 or 403 as a plain command failure, with the status in its detail. */
const isUnauthorized = (error: GitLabCli.GitLabCliError) =>
  error._tag === "GitLabCliAuthenticationError" ||
  (isExitError(error.cause) && UNAUTHORIZED.test(error.cause.detail));

/**
 * Reads GitLab through `glab api` as the host's glab login, the login the pull request features
 * use. Requests are paged by `page`, ordered by `updated_at` ascending, so a capped read resumes
 * from its newest item on the next poll.
 */
export const make = Effect.gen(function* () {
  const gitlab = yield* GitLabCli.GitLabCli;
  // Hosts whose login was confirmed; dropped when a read is refused, so the next poll rechecks.
  const signedInHosts = new Set<string>();

  const failWith = (message: string) => (cause: unknown) =>
    new GitLabProjectsReadError({ message, cause });

  /** Without a login glab reads anonymously, which is never what a trigger should do. */
  const requireLogin = Effect.fn("gitlabProjectsClient.requireLogin")(function* (input: {
    readonly cwd: string;
    readonly host: string;
  }) {
    if (signedInHosts.has(input.host)) return;
    const signedIn = yield* gitlab
      .execute({
        cwd: input.cwd,
        host: input.host,
        args: ["auth", "status", "--hostname", input.host],
      })
      .pipe(
        Effect.map((output) => LOGGED_IN.test(`${output.stdout}\n${output.stderr}`)),
        Effect.orElseSucceed(() => false),
      );
    if (!signedIn) {
      return yield* new GitLabProjectsReadError({
        message: `GitLab has no sign-in on this server for ${input.host}. Run \`glab auth login --hostname ${input.host}\` where T3 Code runs.`,
      });
    }
    signedInHosts.add(input.host);
  });

  const pages = Effect.fn("gitlabProjectsClient.pages")(function* <A>(input: {
    readonly cwd: string;
    readonly host: string;
    readonly path: string;
    readonly query: Readonly<Record<string, string | undefined>>;
    readonly parse: (raw: string) => Result.Result<ReadonlyArray<A>, Schema.SchemaError>;
  }) {
    const items: Array<A> = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const query = new URLSearchParams();
      for (const [name, value] of Object.entries(input.query)) {
        if (value !== undefined) query.set(name, value);
      }
      query.set("per_page", String(PAGE_SIZE));
      query.set("page", String(page));
      const output = yield* gitlab
        .execute({
          cwd: input.cwd,
          host: input.host,
          args: ["api", `${input.path}?${query.toString()}`],
        })
        .pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (isUnauthorized(error)) signedInHosts.delete(input.host);
            }),
          ),
          Effect.mapError((error) => failWith(error.message)(error)),
        );
      const parsed = input.parse(output.stdout);
      if (Result.isFailure(parsed)) {
        return yield* failWith(`GitLab returned an unreadable ${input.path} page.`)(parsed.failure);
      }
      items.push(...parsed.success);
      if (parsed.success.length < PAGE_SIZE) break;
    }
    return items;
  });

  const ordered = (since: string | null) => ({
    order_by: "updated_at",
    sort: "asc",
    ...(since === null ? { state: "opened" } : { updated_after: since }),
  });

  /** `since` null reads the open merge requests, for a seed; otherwise every state. */
  const mergeRequests = (input: {
    readonly cwd: string;
    readonly host: string;
    readonly project?: string;
    readonly group?: string;
    readonly since: string | null;
  }) =>
    pages({
      cwd: input.cwd,
      host: input.host,
      path:
        input.project === undefined
          ? `groups/${encodeURIComponent(input.group ?? "")}/merge_requests`
          : `projects/${encodeURIComponent(input.project)}/merge_requests`,
      query: { ...ordered(input.since), with_merge_status_recheck: "false" },
      parse: (raw) => parseMergeRequestsPage(raw, input.host, input.project ?? null),
    });

  const pipelines = (input: {
    readonly cwd: string;
    readonly host: string;
    readonly project: string;
    readonly since: string;
  }) =>
    pages({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${encodeURIComponent(input.project)}/pipelines`,
      query: { order_by: "updated_at", sort: "asc", updated_after: input.since },
      parse: (raw) => parsePipelinesPage(raw, input.project),
    });

  return { requireLogin, mergeRequests, pipelines };
});
