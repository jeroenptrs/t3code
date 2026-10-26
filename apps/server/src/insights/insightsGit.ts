/**
 * Git reads Insights makes in a project's own checkout. Commit facts, patch-ids and landed
 * detection come from here rather than from the provider, so they cost no API quota. Fetched refs
 * live under `refs/t3/insights/`, beside the checkpoint refs, and never touch the user's branches
 * or remote-tracking refs.
 */
import * as Effect from "effect/Effect";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { FileChange } from "./codingTimeEstimate.ts";
import { isoOf } from "./isoTime.ts";

const INSIGHTS_REF_PREFIX = "refs/t3/insights/";
/** Refs per `git fetch`; one fetch costs one unit of the tick's budget. */
const MERGE_REQUEST_REFS_PER_FETCH = 25;
const COMMITS_PER_READ = 100;
const FETCH_TIMEOUT_MS = 5 * 60_000;
const LOG_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const PATCH_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const RECORD = "\x1e";
const FIELD = "\x1f";
const COAUTHOR_SEPARATOR = "\x1d";
const LOG_FORMAT = [
  `${RECORD}%H`,
  "%P",
  "%ae",
  "%an",
  "%aI",
  "%cI",
  "%s",
  `%(trailers:key=Co-authored-by,valueonly=true,separator=%x1d)${FIELD}`,
].join(FIELD);

export interface GitCommitFacts {
  readonly sha: string;
  readonly parents: ReadonlyArray<string>;
  readonly authorEmail: string;
  readonly authorName: string;
  readonly authoredAt: string;
  readonly committedAt: string;
  readonly subject: string;
  readonly coauthors: ReadonlyArray<string>;
  readonly files: ReadonlyArray<FileChange>;
}

/** Binary files show as `-` in numstat and count zero lines. */
export function parseNumstatLine(line: string): FileChange | null {
  const match = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line);
  if (match === null) return null;
  return {
    path: match[3]!,
    additions: match[1] === "-" ? 0 : Number(match[1]),
    deletions: match[2] === "-" ? 0 : Number(match[2]),
  };
}

function parseCommitLog(output: string): ReadonlyArray<GitCommitFacts> {
  const commits: GitCommitFacts[] = [];
  for (const record of output.split(RECORD)) {
    if (record.trim().length === 0) continue;
    const fields = record.split(FIELD);
    if (fields.length < 9) continue;
    const [sha, parents, authorEmail, authorName, authoredAt, committedAt, subject, coauthors] =
      fields as [string, string, string, string, string, string, string, string];
    const files = fields[8]!
      .split("\n")
      .map((line) => parseNumstatLine(line.trim()))
      .filter((file) => file !== null);
    commits.push({
      sha,
      parents: parents.split(" ").filter((parent) => parent.length > 0),
      authorEmail: authorEmail.trim().toLowerCase(),
      authorName: authorName.trim(),
      authoredAt: isoOf(authoredAt),
      committedAt: isoOf(committedAt),
      subject,
      coauthors: coauthors
        .split(COAUTHOR_SEPARATOR)
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
      files,
    });
  }
  return commits;
}

/** `git patch-id` prints `<patch-id> <commit>` per commit with a diff. */
function parsePatchIds(output: string): ReadonlyMap<string, string> {
  const ids = new Map<string, string>();
  for (const line of output.split("\n")) {
    const [patchId, sha] = line.trim().split(" ");
    if (patchId !== undefined && sha !== undefined && patchId.length > 0) ids.set(sha, patchId);
  }
  return ids;
}

function chunks<A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> {
  const result: A[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

const mergeRequestRef = (number: number) => `${INSIGHTS_REF_PREFIX}mr/${number}`;
const branchRef = (branch: string) => `${INSIGHTS_REF_PREFIX}branch/${branch}`;

export const mergeRequestRefspecs = (numbers: ReadonlyArray<number>) =>
  chunks(
    numbers.map((number) => `+refs/merge-requests/${number}/head:${mergeRequestRef(number)}`),
    MERGE_REQUEST_REFS_PER_FETCH,
  );

/**
 * Fetches merge request heads in batches and returns how many fetches it ran. A batch that fails
 * (a deleted source branch can take its ref with it) is logged and skipped; its commits are then
 * missing locally and left for the next walk.
 */
export const fetchMergeRequestHeads = Effect.fn("InsightsGit.fetchMergeRequestHeads")(
  function* (input: {
    readonly cwd: string;
    readonly remote: string;
    readonly numbers: ReadonlyArray<number>;
  }) {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const batches = mergeRequestRefspecs(input.numbers);
    for (const refspecs of batches) {
      yield* git
        .execute({
          operation: "InsightsGit.fetchMergeRequestHeads",
          cwd: input.cwd,
          args: [
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            "--",
            input.remote,
            ...refspecs,
          ],
          timeoutMs: FETCH_TIMEOUT_MS,
        })
        .pipe(Effect.ignore({ log: true }));
    }
    return batches.length;
  },
);

/** Branch names come from the host and settings; ones git rejects never reach a refspec. */
export const isFetchableBranch = (branch: string) =>
  branch.length > 0 &&
  !branch.startsWith("-") &&
  !branch.startsWith("+") &&
  !branch.includes(":") &&
  !branch.includes("..") &&
  !/[\s~^?*[\\]/.test(branch);

export const fetchBranch = Effect.fn("InsightsGit.fetchBranch")(function* (input: {
  readonly cwd: string;
  readonly remote: string;
  readonly branch: string;
}) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  yield* git.execute({
    operation: "InsightsGit.fetchBranch",
    cwd: input.cwd,
    args: [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--",
      input.remote,
      `+refs/heads/${input.branch}:${branchRef(input.branch)}`,
    ],
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  return branchRef(input.branch);
});

/** The remote's default branch from `refs/remotes/<remote>/HEAD`, without a network call. */
export const localDefaultBranch = Effect.fn("InsightsGit.localDefaultBranch")(function* (input: {
  readonly cwd: string;
  readonly remote: string;
}) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* git.execute({
    operation: "InsightsGit.localDefaultBranch",
    cwd: input.cwd,
    args: ["symbolic-ref", "--quiet", `refs/remotes/${input.remote}/HEAD`],
    allowNonZeroExit: true,
  });
  const prefix = `refs/remotes/${input.remote}/`;
  const ref = result.stdout.trim();
  return result.exitCode === 0 && ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
});

/** Asks the remote; one unit of budget. */
export const remoteBranches = Effect.fn("InsightsGit.remoteBranches")(function* (input: {
  readonly cwd: string;
  readonly remote: string;
}) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* git.execute({
    operation: "InsightsGit.remoteBranches",
    cwd: input.cwd,
    // Patterns filter the listing, so `--heads` with `HEAD` matched nothing. Asking for HEAD and
    // every head keeps the symref line that names the default branch.
    args: ["ls-remote", "--symref", "--", input.remote, "HEAD", "refs/heads/*"],
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  const head = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(result.stdout)?.[1] ?? null;
  const branches = [...result.stdout.matchAll(/^[0-9a-f]+\trefs\/heads\/(\S+)$/gm)].map(
    (match) => match[1]!,
  );
  return { head, branches };
});

/** The shas among `shas` that name commits present in the checkout. */
export const presentCommits = Effect.fn("InsightsGit.presentCommits")(function* (input: {
  readonly cwd: string;
  readonly shas: ReadonlyArray<string>;
}) {
  if (input.shas.length === 0) return new Set<string>();
  const git = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* git.execute({
    operation: "InsightsGit.presentCommits",
    cwd: input.cwd,
    args: ["cat-file", "--batch-check"],
    stdin: `${input.shas.join("\n")}\n`,
  });
  const present = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    const [sha, type] = line.split(" ");
    if (sha !== undefined && type === "commit") present.add(sha);
  }
  return present;
});

/** Facts for the given commits, in the order git prints them. */
export const readCommits = Effect.fn("InsightsGit.readCommits")(function* (input: {
  readonly cwd: string;
  readonly shas: ReadonlyArray<string>;
}) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const commits: GitCommitFacts[] = [];
  for (const batch of chunks(input.shas, COMMITS_PER_READ)) {
    const result = yield* git.execute({
      operation: "InsightsGit.readCommits",
      cwd: input.cwd,
      args: [
        "log",
        "--no-walk=unsorted",
        "--stdin",
        "--numstat",
        "--no-renames",
        `--format=${LOG_FORMAT}`,
      ],
      stdin: `${batch.join("\n")}\n`,
      maxOutputBytes: LOG_MAX_OUTPUT_BYTES,
    });
    commits.push(...parseCommitLog(result.stdout));
  }
  return commits;
});

/** Non-merge commits reachable from `ref` and committed at or after `since`. */
export const readBranchCommits = Effect.fn("InsightsGit.readBranchCommits")(function* (input: {
  readonly cwd: string;
  readonly ref: string;
  readonly since: string;
}) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* git.execute({
    operation: "InsightsGit.readBranchCommits",
    cwd: input.cwd,
    args: [
      "log",
      "--no-merges",
      "--numstat",
      "--no-renames",
      `--since=${input.since}`,
      `--format=${LOG_FORMAT}`,
      input.ref,
      "--",
    ],
    maxOutputBytes: LOG_MAX_OUTPUT_BYTES,
  });
  return parseCommitLog(result.stdout);
});

/**
 * Stable patch-ids, which survive a rebase that did not change the diff. A commit whose patch
 * was cut off by the output limit gets none rather than a wrong one.
 */
export const readPatchIds = Effect.fn("InsightsGit.readPatchIds")(function* (input: {
  readonly cwd: string;
  readonly shas: ReadonlyArray<string>;
}) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const ids = new Map<string, string>();
  for (const batch of chunks(input.shas, COMMITS_PER_READ)) {
    const patches = yield* git.execute({
      operation: "InsightsGit.readPatches",
      cwd: input.cwd,
      args: ["log", "--no-walk=unsorted", "--stdin", "-p", "--no-color", "--format=commit %H"],
      stdin: `${batch.join("\n")}\n`,
      maxOutputBytes: PATCH_MAX_OUTPUT_BYTES,
    });
    let text = patches.stdout;
    let cutOff: string | null = null;
    if (patches.stdoutTruncated) {
      const last = text.lastIndexOf("\ncommit ");
      cutOff = last === -1 ? null : text.slice(last + 8, last + 8 + 40);
      text = last === -1 ? "" : text.slice(0, last + 1);
    }
    if (text.length === 0) continue;
    const result = yield* git.execute({
      operation: "InsightsGit.patchId",
      cwd: input.cwd,
      args: ["patch-id", "--stable"],
      stdin: text,
    });
    for (const [sha, patchId] of parsePatchIds(result.stdout)) {
      if (sha !== cutOff) ids.set(sha, patchId);
    }
  }
  return ids;
});

/** Removes the refs Insights fetched in this checkout. */
export const pruneRefs = Effect.fn("InsightsGit.pruneRefs")(function* (input: {
  readonly cwd: string;
}) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const listed = yield* git.execute({
    operation: "InsightsGit.listRefs",
    cwd: input.cwd,
    args: ["for-each-ref", "--format=%(refname)", INSIGHTS_REF_PREFIX],
  });
  const refs = listed.stdout.split("\n").filter((ref) => ref.startsWith(INSIGHTS_REF_PREFIX));
  if (refs.length === 0) return;
  yield* git.execute({
    operation: "InsightsGit.pruneRefs",
    cwd: input.cwd,
    args: ["update-ref", "--stdin"],
    stdin: refs.map((ref) => `delete ${ref}\n`).join(""),
  });
});
