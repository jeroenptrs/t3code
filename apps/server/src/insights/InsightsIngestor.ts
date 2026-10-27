/**
 * The Insights ingestion step the Scheduler runs every few seconds. Each tick spends at most the
 * configured number of provider calls per host and returns, so a project that is behind takes
 * several ticks: a steady rate instead of a burst. Provider calls go through
 * `PullRequestService.providerProjects`, so `glab`'s login and the shared rate-limit pause apply;
 * commit facts and landed detection come from git in the project's checkout.
 *
 * A merge request walk pages newest-first by `updated_at` until it reaches the project's cursor.
 * Only a finished walk moves the cursor, so a restart mid-walk repeats it; upserts make that
 * harmless. The walk's position is kept in memory between ticks.
 */
import { type InsightsSettings, type ProjectId } from "@t3tools/contracts";
import {
  type ProviderChangeRequest,
  type PullRequestProviderApi,
  PullRequestProviderError,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { parseJiraIssueKeysFrom } from "../jira/issueKeys.ts";
import * as JiraIdentities from "../jira/JiraIdentities.ts";
import * as JiraService from "../jira/JiraService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { estimateCodingTime, hasAgentCoauthor } from "./codingTimeEstimate.ts";
import * as InsightsGit from "./insightsGit.ts";
import * as InsightsStore from "./InsightsStore.ts";
import { isoOf } from "./isoTime.ts";

const MERGE_REQUEST_PAGE_SIZE = 50;
/** A synced project is walked again after this long. */
const SYNC_INTERVAL_MS = 10 * 60_000;
/** A project whose last attempt failed waits this long before the next. */
const RETRY_AFTER_MS = 60_000;
/** GitLab filters at second precision and orders without a tie-break, so walks overlap. */
const CURSOR_OVERLAP_MS = 60_000;
/** A branch commit by the same person this close to their merge request landing is its squash. */
const SQUASH_WINDOW_MS = 10 * 60_000;
/** GitLab lists at most one page of a merge request's commits. */
const COMMIT_LIST_LIMIT = 100;
/** Detail and activity: the two calls that read one merge request. */
const MERGE_REQUEST_COST = 2;
/** One bulk read of issues by key. */
const JIRA_KEYS_PER_CALL = 100;
/** A cached issue, or a key Jira did not return, is read again after this long. */
const JIRA_REFRESH_MS = 24 * 60 * 60_000;

interface Walk {
  /** The project's cursor when the walk started; a reset cursor discards the walk. */
  readonly startCursor: string | null;
  readonly boundary: string;
  readonly full: boolean;
  delivered: number;
  lastUpdatedAt: string | null;
  newest: string | null;
}

interface Meter {
  left: number;
}

interface ReadMergeRequest {
  readonly number: number;
  readonly shas: ReadonlyArray<string>;
  readonly commitsTruncated: boolean;
  readonly author: InsightsStore.ContributorRef | null;
  readonly mergedAt: string | null;
  readonly landedBranch: string | null;
  readonly jiraKeys: ReadonlyArray<string>;
  readonly stored: boolean;
}

export class InsightsIngestor extends Context.Service<
  InsightsIngestor,
  {
    readonly runDueWork: Effect.Effect<void>;
    /** Drops in-memory walk positions after cursors were reset; all projects when omitted. */
    readonly invalidate: (projectId?: ProjectId) => Effect.Effect<void>;
  }
>()("t3/insights/InsightsIngestor") {}

/** `*` matches within a path segment, `**` across segments. */
export function branchMatchesPattern(branch: string, pattern: string): boolean {
  const source = pattern
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${source}$`).test(branch);
}

const minusMs = (iso: string, ms: number) => isoOf(Date.parse(iso) - ms);
const maxIso = (a: string | null, b: string) => (a === null || b > a ? b : a);
const minIso = (a: string | null, b: string) => (a === null || b < a ? b : a);
const normalizeName = (name: string | null | undefined) =>
  (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");

const isProviderError = Schema.is(PullRequestProviderError);
const isRateLimited = (error: unknown) => isProviderError(error) && error.reason === "rate-limited";

/** What the settings page shows for a failed sync; never raw command output. */
function describeFailure(
  error: { readonly _tag: string },
  requirement: PullRequestProviderApi["unavailableRequirement"],
): string {
  if (isProviderError(error)) {
    if (error.reason === "missing-tool" || error.reason === "unauthenticated") {
      const told =
        error.reason === "missing-tool" ? requirement?.missing : requirement?.unauthenticated;
      return told ?? error.detail;
    }
    return `GitLab could not be read: ${error.detail}`;
  }
  if (error._tag === "GitCommandError") {
    return "Git could not read or fetch from this project's checkout.";
  }
  if (error._tag === "SqlError") return "Insights could not read or write its tables.";
  return "Insights could not sync this project.";
}

const make = Effect.gen(function* () {
  const store = yield* InsightsStore.InsightsStore;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const jira = yield* JiraService.JiraService;
  const identities = yield* JiraIdentities.JiraIdentities;
  const walks = yield* Ref.make(new Map<ProjectId, Walk>());
  const failedAt = new Map<ProjectId, number>();

  const invalidate: InsightsIngestor["Service"]["invalidate"] = (projectId) =>
    Ref.update(walks, (current) => {
      if (projectId === undefined) return new Map();
      const next = new Map(current);
      next.delete(projectId);
      return next;
    });

  /**
   * The contributor a commit email belongs to. An email nobody has claimed joins the merge
   * request author's contributor when the commit's author name or the email's local part matches
   * them, so one person does not show up twice in the pending list.
   */
  const contributorForCommit = Effect.fn("InsightsIngestor.contributorForCommit")(function* (
    facts: InsightsGit.GitCommitFacts,
    mergeRequestAuthor: InsightsStore.ContributorRef | null,
  ) {
    const known = yield* store.contributorByEmail(facts.authorEmail);
    if (known !== null) return known;
    if (mergeRequestAuthor !== null) {
      const local = facts.authorEmail.split("@")[0] ?? "";
      const login = mergeRequestAuthor.gitlabLogin?.toLowerCase() ?? null;
      const nameMatches =
        normalizeName(facts.authorName) !== "" &&
        normalizeName(facts.authorName) === normalizeName(mergeRequestAuthor.displayName);
      const loginMatches = login !== null && (local === login || local.endsWith(`-${login}`));
      if (nameMatches || loginMatches) {
        yield* store.addEmail(facts.authorEmail, mergeRequestAuthor.contributorId);
        return mergeRequestAuthor;
      }
    }
    return yield* store.createContributorForEmail({
      email: facts.authorEmail,
      displayName: facts.authorName || null,
    });
  });

  const syncProject = Effect.fn("InsightsIngestor.syncProject")(function* (input: {
    readonly row: InsightsStore.ProjectRow;
    readonly project: PullRequestService.SupportedProject;
    readonly meter: Meter;
    readonly settings: InsightsSettings;
    readonly now: string;
  }) {
    const { row, project, meter, settings, now } = input;
    const api: PullRequestProviderApi = project.api;
    const cwd = project.project.workspaceRoot;
    const remote = project.project.repositoryIdentity?.locator.remoteName ?? "origin";
    const ref = { cwd, repository: project.repository, host: project.host };
    const startBoundary = `${settings.startDate}T00:00:00.000Z`;
    const landedBranchFor = (branch: string, defaultBranch: string | null) =>
      branch === defaultBranch ||
      settings.releaseBranchPatterns.some((pattern) => branchMatchesPattern(branch, pattern))
        ? branch
        : null;

    let defaultBranch = row.defaultBranch;
    if (defaultBranch === null) {
      defaultBranch = yield* InsightsGit.localDefaultBranch({ cwd, remote });
      if (defaultBranch === null && meter.left > 0) {
        meter.left -= 1;
        defaultBranch = (yield* InsightsGit.remoteBranches({ cwd, remote })).head;
      }
      if (defaultBranch !== null) yield* store.saveProgress(row.projectId, { defaultBranch });
    }

    // Merge requests, newest first, until the cursor.
    const current = (yield* Ref.get(walks)).get(row.projectId);
    const walk: Walk =
      current !== undefined && current.startCursor === row.mrCursor
        ? current
        : {
            startCursor: row.mrCursor,
            boundary:
              row.mrCursor === null || row.mrCursor < startBoundary ? startBoundary : row.mrCursor,
            full: row.mrCursor === null,
            delivered: 0,
            lastUpdatedAt: null,
            newest: null,
          };
    yield* Ref.update(walks, (map) => new Map(map).set(row.projectId, walk));

    const read: ReadMergeRequest[] = [];
    let walkDone = false;
    pages: while (meter.left > 0) {
      meter.left -= 1;
      const page = yield* api.listChangeRequests({
        ...ref,
        state: "all",
        involvement: "all",
        viewer: "",
        limit: MERGE_REQUEST_PAGE_SIZE,
        cursor:
          walk.delivered === 0
            ? undefined
            : { updatedBefore: walk.lastUpdatedAt ?? now, delivered: walk.delivered },
      });
      for (const item of page.items) {
        // Stored and compared as strings, so every provider time is normalized first.
        const updatedAt = isoOf(item.updatedAt);
        if (updatedAt < walk.boundary) {
          walkDone = true;
          break pages;
        }
        const storedUpdatedAt = walk.full
          ? null
          : yield* store.mergeRequestUpdatedAt(row.projectId, item.number);
        if (storedUpdatedAt !== updatedAt) {
          if (meter.left < MERGE_REQUEST_COST) break pages;
          meter.left -= MERGE_REQUEST_COST;
          read.push(
            yield* readMergeRequest({
              api,
              item,
              ref,
              projectId: row.projectId,
              landedBranch: landedBranchFor(item.baseBranch, defaultBranch),
            }),
          );
        }
        walk.delivered += 1;
        walk.lastUpdatedAt = item.updatedAt;
        walk.newest = maxIso(walk.newest, updatedAt);
      }
      if (!page.truncated || page.items.length === 0) {
        walkDone = true;
        break;
      }
    }

    yield* storeCommitFacts({ projectId: row.projectId, cwd, remote, meter, read, startBoundary });

    if (!walkDone) return { synced: false };
    yield* Ref.update(walks, (map) => {
      const next = new Map(map);
      next.delete(row.projectId);
      return next;
    });

    // Landed: what reached the default branch, and release branches, since the last walk.
    const branches = defaultBranch === null ? [] : [defaultBranch];
    if (settings.releaseBranchPatterns.length > 0 && meter.left > 0) {
      meter.left -= 1;
      const listed = yield* InsightsGit.remoteBranches({ cwd, remote });
      for (const branch of listed.branches) {
        if (branch !== defaultBranch && landedBranchFor(branch, defaultBranch) !== null) {
          branches.push(branch);
        }
      }
    }
    const since = row.defaultBranchCursor ?? startBoundary;
    let newestLanded: string | null = null;
    let landedComplete = true;
    for (const branch of branches.filter(InsightsGit.isFetchableBranch)) {
      if (meter.left <= 0) {
        landedComplete = false;
        break;
      }
      meter.left -= 1;
      const branchRef = yield* InsightsGit.fetchBranch({ cwd, remote, branch });
      const commits = (yield* InsightsGit.readBranchCommits({
        cwd,
        ref: branchRef,
        since,
      })).toReversed();
      newestLanded = commits.reduce<string | null>(
        (newest, commit) => maxIso(newest, commit.committedAt),
        newestLanded,
      );
      yield* recordLanded({ projectId: row.projectId, cwd, branch, commits, startBoundary });
    }

    yield* store.saveProgress(row.projectId, {
      mrCursor: walk.newest === null ? walk.boundary : minusMs(walk.newest, CURSOR_OVERLAP_MS),
      ...(landedComplete
        ? {
            defaultBranchCursor:
              newestLanded === null ? since : minusMs(newestLanded, CURSOR_OVERLAP_MS),
          }
        : {}),
      lastSyncAt: now,
      lastError: null,
    });
    return { synced: true };
  });

  const readMergeRequest = Effect.fn("InsightsIngestor.readMergeRequest")(function* (input: {
    readonly api: PullRequestProviderApi;
    readonly item: ProviderChangeRequest;
    readonly ref: { readonly cwd: string; readonly repository: string; readonly host: string };
    readonly projectId: ProjectId;
    readonly landedBranch: string | null;
  }) {
    const { api, item, projectId } = input;
    const detail = yield* api.getChangeRequest({ ...input.ref, number: item.number });
    const activity = yield* api.getChangeRequestActivity({ ...input.ref, number: item.number });
    const authorLogin = item.author?.login ?? null;
    const author =
      item.author === null
        ? null
        : yield* store.ensureContributorByLogin({
            login: item.author.login,
            displayName: item.author.name,
            kind: item.author.isBot === true ? "bot" : "human",
          });

    // Reviews: the earliest note and thread comment per person other than the author.
    const earliest = new Map<
      string,
      { kind: "comment" | "thread"; at: string; name: string | null }
    >();
    const consider = (
      actor: {
        readonly login: string;
        readonly name: string | null;
        readonly isBot?: boolean | undefined;
      } | null,
      kind: "comment" | "thread",
      at: string,
    ) => {
      if (actor === null || actor.isBot === true || actor.login === authorLogin) return;
      const key = `${actor.login}\n${kind}`;
      const seen = earliest.get(key);
      if (seen === undefined || at < seen.at) earliest.set(key, { kind, at, name: actor.name });
    };
    for (const comment of activity.comments) {
      consider(comment.author, "comment", isoOf(comment.createdAt));
    }
    for (const thread of activity.reviewThreads) {
      for (const comment of thread.comments) {
        consider(comment.author, "thread", isoOf(comment.createdAt));
      }
    }
    const firstReviewAt = [...earliest.values()].reduce<string | null>(
      (first, review) => minIso(first, review.at),
      null,
    );
    for (const [key, review] of earliest) {
      const login = key.slice(0, key.indexOf("\n"));
      const reviewer = yield* store.ensureContributorByLogin({
        login,
        displayName: review.name,
        kind: "human",
      });
      if (reviewer.status === "included") {
        yield* store.upsertReview({
          projectId,
          number: item.number,
          reviewerContributorId: reviewer.contributorId,
          kind: review.kind,
          firstAt: review.at,
        });
      }
    }

    const jiraKeys = parseJiraIssueKeysFrom([item.title, item.headBranch, detail.body]);
    const optionalIso = (value: string | null | undefined) =>
      value === null || value === undefined ? null : isoOf(value);
    const mergedAt = optionalIso(detail.mergedAt ?? item.mergedAt);
    const stored = author !== null && author.status === "included";
    if (author !== null && stored) {
      yield* store.upsertMergeRequest({
        projectId,
        number: item.number,
        authorContributorId: author.contributorId,
        authorLogin,
        state: item.state,
        isDraft: item.isDraft,
        title: item.title,
        headBranch: item.headBranch,
        baseBranch: item.baseBranch,
        labels: item.labels.map((label) => label.name),
        createdAt: isoOf(item.createdAt),
        mergedAt,
        closedAt: optionalIso(detail.closedAt ?? item.closedAt),
        updatedAt: isoOf(item.updatedAt),
        headSha: detail.headSha ?? null,
        firstReviewAt,
        firstCommitAuthoredAt: null,
        changedFiles: detail.changedFiles,
        commitsTruncated: activity.commits.length >= COMMIT_LIST_LIMIT,
        notesTruncated: activity.commentsTruncated,
        jiraKeys,
      });
    }
    return {
      number: item.number,
      shas: activity.commits.map((commit) => commit.oid.toLowerCase()),
      commitsTruncated: activity.commits.length >= COMMIT_LIST_LIMIT,
      author,
      mergedAt: item.state === "merged" ? mergedAt : null,
      landedBranch: input.landedBranch,
      jiraKeys,
      stored,
    } satisfies ReadMergeRequest;
  });

  /** Commit facts from git for the merge requests read this tick; only included authors' rows. */
  const storeCommitFacts = Effect.fn("InsightsIngestor.storeCommitFacts")(function* (input: {
    readonly projectId: ProjectId;
    readonly cwd: string;
    readonly remote: string;
    readonly meter: Meter;
    readonly read: ReadonlyArray<ReadMergeRequest>;
    readonly startBoundary: string;
  }) {
    const { projectId, cwd, remote, read } = input;
    const allShas = [...new Set(read.flatMap((mergeRequest) => mergeRequest.shas))];
    if (allShas.length === 0 && read.length === 0) return;
    let present = yield* InsightsGit.presentCommits({ cwd, shas: allShas });
    const needFetch = read.filter((mergeRequest) =>
      mergeRequest.shas.some((sha) => !present.has(sha)),
    );
    if (needFetch.length > 0) {
      const fetches = yield* InsightsGit.fetchMergeRequestHeads({
        cwd,
        remote,
        numbers: needFetch.map((mergeRequest) => mergeRequest.number),
      });
      input.meter.left -= fetches;
      present = yield* InsightsGit.presentCommits({ cwd, shas: allShas });
    }
    const readable = allShas.filter((sha) => present.has(sha));
    const facts = new Map(
      (yield* InsightsGit.readCommits({ cwd, shas: readable })).map((commit) => [
        commit.sha,
        commit,
      ]),
    );
    const stored = yield* store.commitsBySha(projectId, readable);
    const newShas = new Set(readable.filter((sha) => !stored.has(sha)));
    const patchIds = yield* InsightsGit.readPatchIds({ cwd, shas: readable });

    for (const mergeRequest of read) {
      let firstAuthoredAt: string | null = null;
      for (const sha of mergeRequest.shas) {
        const commit = facts.get(sha);
        // A merge of the target branch into the feature branch is not the author's work.
        if (commit === undefined || commit.parents.length > 1) continue;
        firstAuthoredAt = minIso(firstAuthoredAt, commit.authoredAt);
        if (!newShas.has(sha) || commit.committedAt < input.startBoundary) continue;
        const contributor = yield* contributorForCommit(commit, mergeRequest.author);
        if (contributor.status !== "included") continue;
        const estimate = estimateCodingTime(commit.files);
        yield* store.insertCommit({
          projectId,
          sha,
          contributorId: contributor.contributorId,
          authorEmail: commit.authorEmail,
          authoredAt: commit.authoredAt,
          committedAt: commit.committedAt,
          mrNumber: mergeRequest.number,
          patchId: patchIds.get(sha) ?? null,
          additions: estimate.additions,
          deletions: estimate.deletions,
          filesChanged: estimate.filesChanged,
          fileMix: estimate.fileMix,
          estimatedHours: estimate.hours,
          landedAt: null,
          landedBranch: null,
          hasAgentCoauthor: hasAgentCoauthor(commit.coauthors),
          jiraKeys: parseJiraIssueKeysFrom([commit.subject, ...mergeRequest.jiraKeys]),
          messageSubject: commit.subject,
        });
      }
      if (mergeRequest.stored && firstAuthoredAt !== null) {
        yield* store.setFirstCommitAuthoredAt(projectId, mergeRequest.number, firstAuthoredAt);
      }

      // A rebase replaced commits: point each old one at the new commit with the same patch.
      if (!mergeRequest.commitsTruncated) {
        const current = new Set(mergeRequest.shas);
        const byPatchId = new Map(
          mergeRequest.shas.flatMap((sha) => {
            const patchId = patchIds.get(sha);
            return patchId === undefined ? [] : [[patchId, sha] as const];
          }),
        );
        for (const previous of yield* store.mergeRequestCommits(projectId, mergeRequest.number)) {
          if (current.has(previous.sha) || previous.supersededBySha !== null) continue;
          const replacement =
            previous.patchId === null ? undefined : byPatchId.get(previous.patchId);
          yield* store.supersede(projectId, previous.sha, replacement ?? "rebased");
        }
      }
      if (mergeRequest.mergedAt !== null && mergeRequest.landedBranch !== null) {
        yield* store.markMergeRequestLanded({
          projectId,
          number: mergeRequest.number,
          landedAt: mergeRequest.mergedAt,
          branch: mergeRequest.landedBranch,
        });
      }
    }
  });

  /**
   * A branch commit is a stored commit landing, a stored commit rewritten by a fast-forward or
   * semi-linear merge (same patch-id), a merge request's squash commit, or a direct push.
   */
  const recordLanded = Effect.fn("InsightsIngestor.recordLanded")(function* (input: {
    readonly projectId: ProjectId;
    readonly cwd: string;
    readonly branch: string;
    readonly commits: ReadonlyArray<InsightsGit.GitCommitFacts>;
    readonly startBoundary: string;
  }) {
    const { projectId, branch, commits } = input;
    if (commits.length === 0) return;
    const stored = yield* store.commitsBySha(
      projectId,
      commits.map((commit) => commit.sha),
    );
    const unknown = commits.filter((commit) => !stored.has(commit.sha));
    const patchIds = yield* InsightsGit.readPatchIds({
      cwd: input.cwd,
      shas: unknown.map((commit) => commit.sha),
    });
    for (const commit of commits) {
      const known = stored.get(commit.sha);
      if (known !== undefined) {
        if (known.landedAt === null) {
          yield* store.markCommitLanded({
            projectId,
            sha: commit.sha,
            landedAt: commit.committedAt,
            branch,
          });
        }
        continue;
      }
      const patchId = patchIds.get(commit.sha) ?? null;
      const rewritten =
        patchId === null ? null : yield* store.unlandedCommitByPatchId(projectId, patchId);
      if (rewritten !== null) {
        yield* store.markCommitLanded({
          projectId,
          sha: rewritten.sha,
          landedAt: commit.committedAt,
          branch,
        });
        continue;
      }
      if (commit.committedAt < input.startBoundary) continue;
      const contributor = yield* contributorForCommit(commit, null);
      if (contributor.status !== "included") continue;
      const squash = yield* store.hasMergeRequestLandedNear({
        projectId,
        contributorId: contributor.contributorId,
        at: commit.committedAt,
        windowMs: SQUASH_WINDOW_MS,
      });
      if (squash) continue;
      const estimate = estimateCodingTime(commit.files);
      yield* store.insertCommit({
        projectId,
        sha: commit.sha,
        contributorId: contributor.contributorId,
        authorEmail: commit.authorEmail,
        authoredAt: commit.authoredAt,
        committedAt: commit.committedAt,
        mrNumber: null,
        patchId,
        additions: estimate.additions,
        deletions: estimate.deletions,
        filesChanged: estimate.filesChanged,
        fileMix: estimate.fileMix,
        estimatedHours: estimate.hours,
        landedAt: commit.committedAt,
        landedBranch: branch,
        hasAgentCoauthor: hasAgentCoauthor(commit.coauthors),
        jiraKeys: parseJiraIssueKeysFrom([commit.subject]),
        messageSubject: commit.subject,
      });
    }
  });

  /**
   * The issue behind each key stored rows carry, a bulk read per call against the site's own
   * budget. Git carries keys but no site, so every key is read on the reader's site.
   */
  const syncJiraIssues = Effect.fn("InsightsIngestor.syncJiraIssues")(function* (input: {
    readonly meters: Map<string, Meter>;
    readonly budget: number;
    readonly now: string;
    readonly nowMs: number;
  }) {
    if (!identities.configured) return;
    const { site } = yield* identities.reader;
    const host = `jira:${site}`;
    const meter = input.meters.get(host) ?? { left: input.budget };
    input.meters.set(host, meter);
    while (meter.left > 0) {
      const keys = yield* store.staleJiraKeys({
        site,
        olderThanIso: isoOf(input.nowMs - JIRA_REFRESH_MS),
        limit: JIRA_KEYS_PER_CALL,
      });
      if (keys.length === 0) return;
      meter.left -= 1;
      const issues = new Map(
        (yield* jira.issuesByKeys(site, keys)).map((issue) => [issue.key, issue]),
      );
      yield* store.putJiraIssues({
        site,
        fetchedAt: input.now,
        rows: keys.map((key) => {
          const issue = issues.get(key);
          return {
            key,
            issueType: issue?.issueType ?? null,
            statusCategory: issue?.statusCategory ?? null,
            parentKey: issue?.parentKey ?? null,
            summary: issue?.summary ?? null,
          };
        }),
      });
      if (keys.length < JIRA_KEYS_PER_CALL) return;
    }
  });

  const runDueWork: InsightsIngestor["Service"]["runDueWork"] = Effect.gen(function* () {
    const rows = (yield* store.projects).filter((row) => row.enabled);
    if (rows.length === 0) return;
    const settings = yield* store.settings;
    const nowMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    const now = isoOf(nowMs);
    const inProgress = yield* Ref.get(walks);
    const due = rows.filter((row) => {
      const failed = failedAt.get(row.projectId);
      if (failed !== undefined && nowMs - failed < RETRY_AFTER_MS) return false;
      return (
        inProgress.has(row.projectId) ||
        row.mrCursor === null ||
        row.lastSyncAt === null ||
        nowMs - Date.parse(row.lastSyncAt) >= SYNC_INTERVAL_MS
      );
    });
    if (due.length === 0) return;
    // Walks in progress and rescans first, then the project synced longest ago.
    due.sort((a, b) => {
      const urgent = (row: InsightsStore.ProjectRow) =>
        inProgress.has(row.projectId) || row.mrCursor === null ? 0 : 1;
      return urgent(a) - urgent(b) || (a.lastSyncAt ?? "").localeCompare(b.lastSyncAt ?? "");
    });

    const providerProjects = new Map(
      (yield* pullRequests.providerProjects()).map((project) => [project.project.id, project]),
    );
    const meters = new Map<string, Meter>();
    for (const row of due) {
      const project = providerProjects.get(row.projectId);
      if (project === undefined || project.api.kind !== "gitlab") {
        yield* store.saveProgress(row.projectId, {
          lastError: "This project no longer has a GitLab remote.",
        });
        continue;
      }
      let meter = meters.get(project.host);
      if (meter === undefined) {
        meter = { left: settings.requestBudgetPerTick };
        meters.set(project.host, meter);
      }
      if (meter.left <= 0) continue;
      const hostMeter = meter;
      yield* syncProject({ row, project, meter: hostMeter, settings, now }).pipe(
        Effect.tap(() => Effect.sync(() => failedAt.delete(row.projectId))),
        Effect.catch((error) => {
          // The shared pause already holds this host for everything; resume on a later tick.
          if (isRateLimited(error)) {
            hostMeter.left = 0;
            return Effect.void;
          }
          failedAt.set(row.projectId, nowMs);
          return Effect.logWarning("Insights could not sync a project", {
            projectId: row.projectId,
            errorTag: error._tag,
          }).pipe(
            Effect.andThen(
              store.saveProgress(row.projectId, {
                lastError: describeFailure(error, project.api.unavailableRequirement),
              }),
            ),
            Effect.ignore,
          );
        }),
      );
    }

    // Only ticks that synced a project get here, and those are when new keys arrive.
    yield* syncJiraIssues({ meters, budget: settings.requestBudgetPerTick, now, nowMs }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Insights could not read Jira issues", { errorTag: error._tag }),
      ),
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Insights ingestion tick failed", { errorTag: error._tag }),
    ),
    Effect.provideService(GitVcsDriver.GitVcsDriver, git),
  );

  return InsightsIngestor.of({ runDueWork, invalidate });
});

export const layer = Layer.effect(InsightsIngestor, make);
