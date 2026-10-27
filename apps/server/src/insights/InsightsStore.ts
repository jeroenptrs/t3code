/**
 * SQL over the `fork_insights_*` tables. Every insert of a commit, merge request or review checks
 * in the same statement that its contributor is included and its project enabled, so an
 * ingestion tick racing an administrator's exclude or disable cannot store what they removed.
 */
import type {
  AuthUserId,
  InsightsContributor,
  InsightsContributorId,
  InsightsContributorKind,
  InsightsContributorStatus,
  InsightsSettings,
  ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlError from "effect/sql/SqlError";
import * as SqlClient from "effect/sql/SqlClient";

import { isoOf } from "./isoTime.ts";
import type { RollupInput } from "./insightsRollup.ts";

const DEFAULT_REQUEST_BUDGET_PER_TICK = 20;
const DEFAULT_LOOKBACK_DAYS = 90;
const DAY_MS = 86_400_000;

export interface ContributorRef {
  readonly contributorId: InsightsContributorId;
  readonly displayName: string | null;
  readonly gitlabLogin: string | null;
  readonly status: InsightsContributorStatus;
}

export interface ProjectRow {
  readonly projectId: ProjectId;
  readonly host: string;
  readonly repository: string;
  readonly defaultBranch: string | null;
  readonly enabled: boolean;
  readonly mrCursor: string | null;
  readonly defaultBranchCursor: string | null;
  readonly lastSyncAt: string | null;
  readonly lastError: string | null;
}

export interface MergeRequestRow {
  readonly projectId: ProjectId;
  readonly number: number;
  readonly authorContributorId: InsightsContributorId;
  readonly authorLogin: string | null;
  readonly state: string;
  readonly isDraft: boolean;
  readonly title: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly labels: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly updatedAt: string;
  readonly headSha: string | null;
  readonly firstReviewAt: string | null;
  readonly firstCommitAuthoredAt: string | null;
  readonly changedFiles: number | null;
  readonly commitsTruncated: boolean;
  readonly notesTruncated: boolean;
  readonly jiraKeys: ReadonlyArray<string>;
}

export interface CommitRow {
  readonly projectId: ProjectId;
  readonly sha: string;
  readonly contributorId: InsightsContributorId;
  readonly authorEmail: string;
  readonly authoredAt: string;
  readonly committedAt: string;
  readonly mrNumber: number | null;
  readonly patchId: string | null;
  readonly additions: number;
  readonly deletions: number;
  readonly filesChanged: number;
  readonly fileMix: number;
  readonly estimatedHours: number;
  readonly landedAt: string | null;
  readonly landedBranch: string | null;
  readonly hasAgentCoauthor: boolean;
  readonly jiraKeys: ReadonlyArray<string>;
  readonly messageSubject: string;
}

export interface StoredCommit {
  readonly sha: string;
  readonly contributorId: InsightsContributorId;
  readonly mrNumber: number | null;
  readonly patchId: string | null;
  readonly landedAt: string | null;
  readonly supersededBySha: string | null;
}

export type OverviewRows = Pick<
  RollupInput,
  "contributors" | "commits" | "mergeRequests" | "reviews"
>;

type Sql<A> = Effect.Effect<A, SqlError.SqlError>;

export class InsightsStore extends Context.Service<
  InsightsStore,
  {
    readonly settings: Sql<InsightsSettings>;
    readonly putSettings: (
      patch: {
        readonly [K in keyof Omit<InsightsSettings, "updatedAt">]?: InsightsSettings[K] | undefined;
      },
      userId: AuthUserId | null,
    ) => Sql<void>;

    readonly projects: Sql<ReadonlyArray<ProjectRow>>;
    readonly setProjectEnabled: (input: {
      readonly projectId: ProjectId;
      readonly host: string;
      readonly repository: string;
      readonly enabled: boolean;
      readonly userId: AuthUserId | null;
    }) => Sql<void>;
    /** Null cursors make the next walk start from the start date and refetch everything. */
    readonly resetCursors: (projectIds?: ReadonlyArray<ProjectId>) => Sql<void>;
    readonly saveProgress: (
      projectId: ProjectId,
      progress: {
        readonly mrCursor?: string | null;
        readonly defaultBranchCursor?: string | null;
        readonly defaultBranch?: string;
        readonly lastSyncAt?: string;
        readonly lastError?: string | null;
      },
    ) => Sql<void>;

    readonly contributors: Sql<ReadonlyArray<InsightsContributor>>;
    readonly contributor: (contributorId: InsightsContributorId) => Sql<ContributorRef | null>;
    readonly contributorByEmail: (email: string) => Sql<ContributorRef | null>;
    /** The contributor for a provider login, created as pending the first time it is seen. */
    readonly ensureContributorByLogin: (input: {
      readonly login: string;
      readonly displayName: string | null;
      readonly kind: InsightsContributorKind;
    }) => Sql<ContributorRef>;
    /**
     * The contributor for a commit email, created as pending the first time it is seen and linked
     * to the portal user with that email, if any.
     */
    readonly createContributorForEmail: (input: {
      readonly email: string;
      readonly displayName: string | null;
    }) => Sql<ContributorRef>;
    readonly addEmail: (email: string, contributorId: InsightsContributorId) => Sql<void>;
    readonly updateContributor: (
      contributorId: InsightsContributorId,
      update: {
        readonly status?: InsightsContributorStatus;
        readonly kind?: InsightsContributorKind;
        readonly displayName?: string;
      },
      userId: AuthUserId | null,
    ) => Sql<void>;
    readonly deleteContributorRows: (contributorId: InsightsContributorId) => Sql<void>;
    readonly mergeContributors: (
      source: InsightsContributorId,
      target: InsightsContributorId,
    ) => Sql<void>;

    readonly mergeRequestUpdatedAt: (projectId: ProjectId, number: number) => Sql<string | null>;
    readonly upsertMergeRequest: (row: MergeRequestRow) => Sql<void>;
    readonly upsertReview: (input: {
      readonly projectId: ProjectId;
      readonly number: number;
      readonly reviewerContributorId: InsightsContributorId;
      readonly kind: "comment" | "thread";
      readonly firstAt: string;
    }) => Sql<void>;

    readonly commitsBySha: (
      projectId: ProjectId,
      shas: ReadonlyArray<string>,
    ) => Sql<ReadonlyMap<string, StoredCommit>>;
    readonly insertCommit: (row: CommitRow) => Sql<void>;
    readonly mergeRequestCommits: (
      projectId: ProjectId,
      number: number,
    ) => Sql<ReadonlyArray<StoredCommit>>;
    readonly supersede: (projectId: ProjectId, sha: string, bySha: string) => Sql<void>;
    readonly markMergeRequestLanded: (input: {
      readonly projectId: ProjectId;
      readonly number: number;
      readonly landedAt: string;
      readonly branch: string;
    }) => Sql<void>;
    readonly markCommitLanded: (input: {
      readonly projectId: ProjectId;
      readonly sha: string;
      readonly landedAt: string;
      readonly branch: string;
    }) => Sql<void>;
    readonly unlandedCommitByPatchId: (
      projectId: ProjectId,
      patchId: string,
    ) => Sql<StoredCommit | null>;
    /**
     * Whether the contributor has merge request commits that landed within `windowMs` of `at`:
     * a commit on the branch that close to their merge is the merge request's squash commit.
     */
    readonly hasMergeRequestLandedNear: (input: {
      readonly projectId: ProjectId;
      readonly contributorId: InsightsContributorId;
      readonly at: string;
      readonly windowMs: number;
    }) => Sql<boolean>;
    readonly setFirstCommitAuthoredAt: (
      projectId: ProjectId,
      number: number,
      authoredAt: string,
    ) => Sql<void>;

    readonly overviewRows: (input: {
      readonly fromIso: string;
      readonly toIso: string;
      readonly contributorIds?: ReadonlyArray<InsightsContributorId> | undefined;
    }) => Sql<OverviewRows>;
  }
>()("t3/insights/InsightsStore") {}

const nowIso = Effect.map(
  Effect.clockWith((clock) => clock.currentTimeMillis),
  isoOf,
);

interface ContributorDbRow {
  readonly contributor_id: string;
  readonly display_name: string | null;
  readonly gitlab_login: string | null;
  readonly status: InsightsContributorStatus;
}

const toRef = (row: ContributorDbRow): ContributorRef => ({
  contributorId: row.contributor_id as InsightsContributorId,
  displayName: row.display_name,
  gitlabLogin: row.gitlab_login,
  status: row.status,
});

interface CommitDbRow {
  readonly sha: string;
  readonly contributor_id: string;
  readonly mr_number: number | null;
  readonly patch_id: string | null;
  readonly landed_at: string | null;
  readonly superseded_by_sha: string | null;
}

const toStoredCommit = (row: CommitDbRow): StoredCommit => ({
  sha: row.sha,
  contributorId: row.contributor_id as InsightsContributorId,
  mrNumber: row.mr_number,
  patchId: row.patch_id,
  landedAt: row.landed_at,
  supersededBySha: row.superseded_by_sha,
});

const COMMIT_COLUMNS = "sha, contributor_id, mr_number, patch_id, landed_at, superseded_by_sha";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const newContributorId = crypto.randomUUIDv4().pipe(
    Effect.orDie,
    Effect.map((uuid) => uuid as InsightsContributorId),
  );

  const settings: InsightsStore["Service"]["settings"] = Effect.gen(function* () {
    const rows = yield* sql<{
      readonly key: string;
      readonly value_json: string;
      readonly updated_at: string;
    }>`SELECT key, value_json, updated_at FROM fork_insights_settings`;
    const values = new Map(rows.map((row) => [row.key, JSON.parse(row.value_json) as unknown]));
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    const startDate = values.get("start_date");
    const patterns = values.get("release_branch_patterns");
    const budget = values.get("request_budget_per_tick");
    return {
      startDate:
        typeof startDate === "string"
          ? startDate
          : isoOf(now - DEFAULT_LOOKBACK_DAYS * DAY_MS).slice(0, 10),
      releaseBranchPatterns: Array.isArray(patterns)
        ? patterns.filter((pattern): pattern is string => typeof pattern === "string")
        : [],
      requestBudgetPerTick: typeof budget === "number" ? budget : DEFAULT_REQUEST_BUDGET_PER_TICK,
      updatedAt: rows.reduce<string | null>(
        (latest, row) => (latest === null || row.updated_at > latest ? row.updated_at : latest),
        null,
      ),
    };
  });

  const putSetting = (key: string, value: unknown, userId: AuthUserId | null, at: string) => sql`
    INSERT INTO fork_insights_settings (key, value_json, updated_by_user_id, updated_at)
    VALUES (${key}, ${JSON.stringify(value)}, ${userId}, ${at})
    ON CONFLICT (key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_by_user_id = excluded.updated_by_user_id,
      updated_at = excluded.updated_at
  `;

  const putSettings: InsightsStore["Service"]["putSettings"] = Effect.fn(
    "InsightsStore.putSettings",
  )(function* (patch, userId) {
    const at = yield* nowIso;
    if (patch.startDate !== undefined) yield* putSetting("start_date", patch.startDate, userId, at);
    if (patch.releaseBranchPatterns !== undefined) {
      yield* putSetting("release_branch_patterns", patch.releaseBranchPatterns, userId, at);
    }
    if (patch.requestBudgetPerTick !== undefined) {
      yield* putSetting("request_budget_per_tick", patch.requestBudgetPerTick, userId, at);
    }
  });

  const projects: InsightsStore["Service"]["projects"] = sql<{
    readonly project_id: string;
    readonly host: string;
    readonly repository: string;
    readonly default_branch: string | null;
    readonly enabled: number;
    readonly mr_cursor: string | null;
    readonly default_branch_cursor: string | null;
    readonly last_sync_at: string | null;
    readonly last_error: string | null;
  }>`
    SELECT project_id, host, repository, default_branch, enabled, mr_cursor,
      default_branch_cursor, last_sync_at, last_error
    FROM fork_insights_projects
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        projectId: row.project_id as ProjectId,
        host: row.host,
        repository: row.repository,
        defaultBranch: row.default_branch,
        enabled: row.enabled === 1,
        mrCursor: row.mr_cursor,
        defaultBranchCursor: row.default_branch_cursor,
        lastSyncAt: row.last_sync_at,
        lastError: row.last_error,
      })),
    ),
  );

  const deleteProjectRows = (projectId: ProjectId) =>
    Effect.all(
      [
        sql`DELETE FROM fork_insights_commits WHERE project_id = ${projectId}`,
        sql`DELETE FROM fork_insights_merge_requests WHERE project_id = ${projectId}`,
        sql`DELETE FROM fork_insights_mr_reviews WHERE project_id = ${projectId}`,
      ],
      { discard: true },
    );

  const setProjectEnabled: InsightsStore["Service"]["setProjectEnabled"] = (input) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const at = yield* nowIso;
        yield* sql`
          INSERT INTO fork_insights_projects (
            project_id, host, repository, enabled, enabled_at, enabled_by_user_id
          ) VALUES (
            ${input.projectId}, ${input.host}, ${input.repository}, ${input.enabled ? 1 : 0},
            ${input.enabled ? at : null}, ${input.enabled ? input.userId : null}
          )
          ON CONFLICT (project_id) DO UPDATE SET
            host = excluded.host,
            repository = excluded.repository,
            enabled = excluded.enabled,
            enabled_at = excluded.enabled_at,
            enabled_by_user_id = excluded.enabled_by_user_id,
            mr_cursor = NULL,
            default_branch_cursor = NULL,
            last_error = NULL
        `;
        if (!input.enabled) yield* deleteProjectRows(input.projectId);
      }),
    );

  const resetCursors: InsightsStore["Service"]["resetCursors"] = (projectIds) =>
    projectIds === undefined
      ? sql`
          UPDATE fork_insights_projects SET mr_cursor = NULL, default_branch_cursor = NULL
          WHERE enabled = 1
        `.pipe(Effect.asVoid)
      : projectIds.length === 0
        ? Effect.void
        : sql`
            UPDATE fork_insights_projects SET mr_cursor = NULL, default_branch_cursor = NULL
            WHERE project_id IN ${sql.in(projectIds)}
          `.pipe(Effect.asVoid);

  const saveProgress: InsightsStore["Service"]["saveProgress"] = Effect.fn(
    "InsightsStore.saveProgress",
  )(function* (projectId, progress) {
    const updates: Record<string, string | null> = {};
    if (progress.mrCursor !== undefined) updates.mr_cursor = progress.mrCursor;
    if (progress.defaultBranchCursor !== undefined) {
      updates.default_branch_cursor = progress.defaultBranchCursor;
    }
    if (progress.defaultBranch !== undefined) updates.default_branch = progress.defaultBranch;
    if (progress.lastSyncAt !== undefined) updates.last_sync_at = progress.lastSyncAt;
    if (progress.lastError !== undefined) updates.last_error = progress.lastError;
    if (Object.keys(updates).length === 0) return;
    yield* sql`
        UPDATE fork_insights_projects SET ${sql.update(updates)}
        WHERE project_id = ${projectId}
      `;
  });

  const contributors: InsightsStore["Service"]["contributors"] = Effect.gen(function* () {
    const rows = yield* sql<{
      readonly contributor_id: string;
      readonly display_name: string | null;
      readonly status: InsightsContributorStatus;
      readonly kind: InsightsContributorKind;
      readonly user_id: string | null;
      readonly gitlab_login: string | null;
      readonly first_seen_at: string;
      readonly decided_at: string | null;
    }>`
      SELECT contributor_id, display_name, status, kind, user_id, gitlab_login, first_seen_at,
        decided_at
      FROM fork_insights_contributors
      ORDER BY COALESCE(display_name, gitlab_login, contributor_id) COLLATE NOCASE
    `;
    const emails = yield* sql<{ readonly email: string; readonly contributor_id: string }>`
      SELECT email, contributor_id FROM fork_insights_contributor_emails ORDER BY email
    `;
    const byContributor = new Map<string, string[]>();
    for (const { email, contributor_id } of emails) {
      const list = byContributor.get(contributor_id);
      if (list === undefined) byContributor.set(contributor_id, [email]);
      else list.push(email);
    }
    return rows.map((row) => ({
      contributorId: row.contributor_id as InsightsContributorId,
      displayName: row.display_name,
      status: row.status,
      kind: row.kind,
      userId: row.user_id as AuthUserId | null,
      gitlabLogin: row.gitlab_login,
      emails: byContributor.get(row.contributor_id) ?? [],
      firstSeenAt: row.first_seen_at,
      decidedAt: row.decided_at,
    }));
  });

  const contributor: InsightsStore["Service"]["contributor"] = (contributorId) =>
    sql<ContributorDbRow>`
      SELECT contributor_id, display_name, gitlab_login, status FROM fork_insights_contributors
      WHERE contributor_id = ${contributorId}
    `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : toRef(rows[0]))));

  const contributorByEmail: InsightsStore["Service"]["contributorByEmail"] = (email) =>
    sql<ContributorDbRow>`
      SELECT c.contributor_id, c.display_name, c.gitlab_login, c.status
      FROM fork_insights_contributor_emails e
      JOIN fork_insights_contributors c ON c.contributor_id = e.contributor_id
      WHERE e.email = ${email}
    `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : toRef(rows[0]))));

  const contributorByLogin = (login: string) =>
    sql<ContributorDbRow>`
      SELECT contributor_id, display_name, gitlab_login, status FROM fork_insights_contributors
      WHERE gitlab_login = ${login}
    `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : toRef(rows[0]))));

  const ensureContributorByLogin: InsightsStore["Service"]["ensureContributorByLogin"] = Effect.fn(
    "InsightsStore.ensureContributorByLogin",
  )(function* (input) {
    const existing = yield* contributorByLogin(input.login);
    if (existing !== null) return existing;
    yield* sql`
        INSERT OR IGNORE INTO fork_insights_contributors (
          contributor_id, display_name, status, kind, gitlab_login, first_seen_at
        ) VALUES (
          ${yield* newContributorId}, ${input.displayName}, 'pending', ${input.kind},
          ${input.login}, ${yield* nowIso}
        )
      `;
    return (yield* contributorByLogin(input.login))!;
  });

  const createContributorForEmail: InsightsStore["Service"]["createContributorForEmail"] = (
    input,
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* contributorByEmail(input.email);
        if (existing !== null) return existing;
        const portal = yield* sql<{
          readonly user_id: string;
          readonly display_name: string | null;
          readonly account_id: string | null;
        }>`
          SELECT u.user_id, u.display_name, j.account_id
          FROM auth_users u
          LEFT JOIN fork_jira_user_credentials j ON j.user_id = u.user_id
          WHERE u.email = ${input.email} COLLATE NOCASE
          LIMIT 1
        `;
        const contributorId = yield* newContributorId;
        yield* sql`
          INSERT INTO fork_insights_contributors (
            contributor_id, display_name, status, kind, user_id, jira_account_id, first_seen_at
          ) VALUES (
            ${contributorId}, ${portal[0]?.display_name ?? input.displayName}, 'pending', 'human',
            ${portal[0]?.user_id ?? null}, ${portal[0]?.account_id ?? null}, ${yield* nowIso}
          )
        `;
        yield* sql`
          INSERT INTO fork_insights_contributor_emails (email, contributor_id)
          VALUES (${input.email}, ${contributorId})
        `;
        return (yield* contributor(contributorId))!;
      }),
    );

  const addEmail: InsightsStore["Service"]["addEmail"] = (email, contributorId) =>
    sql`
      INSERT OR IGNORE INTO fork_insights_contributor_emails (email, contributor_id)
      VALUES (${email}, ${contributorId})
    `.pipe(Effect.asVoid);

  const deleteContributorRows: InsightsStore["Service"]["deleteContributorRows"] = (
    contributorId,
  ) =>
    Effect.all(
      [
        sql`DELETE FROM fork_insights_commits WHERE contributor_id = ${contributorId}`,
        sql`DELETE FROM fork_insights_merge_requests WHERE author_contributor_id = ${contributorId}`,
        sql`DELETE FROM fork_insights_mr_reviews WHERE reviewer_contributor_id = ${contributorId}`,
      ],
      { discard: true },
    );

  const updateContributor: InsightsStore["Service"]["updateContributor"] = (
    contributorId,
    update,
    userId,
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const at = yield* nowIso;
        if (update.status !== undefined) {
          yield* sql`
            UPDATE fork_insights_contributors
            SET status = ${update.status}, decided_at = ${at}, decided_by_user_id = ${userId}
            WHERE contributor_id = ${contributorId}
          `;
          if (update.status !== "included") yield* deleteContributorRows(contributorId);
        }
        if (update.kind !== undefined) {
          yield* sql`
            UPDATE fork_insights_contributors SET kind = ${update.kind}
            WHERE contributor_id = ${contributorId}
          `;
        }
        if (update.displayName !== undefined) {
          yield* sql`
            UPDATE fork_insights_contributors SET display_name = ${update.displayName}
            WHERE contributor_id = ${contributorId}
          `;
        }
      }),
    );

  const mergeContributors: InsightsStore["Service"]["mergeContributors"] = (source, target) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          UPDATE fork_insights_contributor_emails SET contributor_id = ${target}
          WHERE contributor_id = ${source}
        `;
        // The login moves only when the target has none; the unique index allows one owner.
        const [sourceRow] = yield* sql<{
          readonly gitlab_login: string | null;
          readonly user_id: string | null;
          readonly jira_account_id: string | null;
        }>`
          SELECT gitlab_login, user_id, jira_account_id FROM fork_insights_contributors
          WHERE contributor_id = ${source}
        `;
        yield* sql`
          UPDATE fork_insights_contributors SET gitlab_login = NULL WHERE contributor_id = ${source}
        `;
        yield* sql`
          UPDATE fork_insights_contributors SET
            gitlab_login = COALESCE(gitlab_login, ${sourceRow?.gitlab_login ?? null}),
            user_id = COALESCE(user_id, ${sourceRow?.user_id ?? null}),
            jira_account_id = COALESCE(jira_account_id, ${sourceRow?.jira_account_id ?? null})
          WHERE contributor_id = ${target}
        `;
        yield* sql`
          UPDATE fork_insights_commits SET contributor_id = ${target}
          WHERE contributor_id = ${source}
        `;
        yield* sql`
          UPDATE fork_insights_merge_requests SET author_contributor_id = ${target}
          WHERE author_contributor_id = ${source}
        `;
        yield* sql`
          INSERT INTO fork_insights_mr_reviews (
            project_id, number, reviewer_contributor_id, kind, first_at
          )
          SELECT project_id, number, ${target}, kind, first_at FROM fork_insights_mr_reviews
          WHERE reviewer_contributor_id = ${source}
          ON CONFLICT (project_id, number, reviewer_contributor_id, kind) DO UPDATE SET
            first_at = MIN(fork_insights_mr_reviews.first_at, excluded.first_at)
        `;
        yield* sql`DELETE FROM fork_insights_mr_reviews WHERE reviewer_contributor_id = ${source}`;
        yield* sql`DELETE FROM fork_insights_contributors WHERE contributor_id = ${source}`;
        const [targetRow] = yield* sql<{ readonly status: string }>`
          SELECT status FROM fork_insights_contributors WHERE contributor_id = ${target}
        `;
        // Rows moved onto a contributor who is not included would break the pending gate.
        if (targetRow?.status !== "included") yield* deleteContributorRows(target);
      }),
    );

  const mergeRequestUpdatedAt: InsightsStore["Service"]["mergeRequestUpdatedAt"] = (
    projectId,
    number,
  ) =>
    sql<{ readonly updated_at: string }>`
      SELECT updated_at FROM fork_insights_merge_requests
      WHERE project_id = ${projectId} AND number = ${number}
    `.pipe(Effect.map((rows) => rows[0]?.updated_at ?? null));

  const upsertMergeRequest: InsightsStore["Service"]["upsertMergeRequest"] = (row) =>
    sql`
      INSERT INTO fork_insights_merge_requests (
        project_id, number, author_contributor_id, author_login, state, is_draft, title,
        head_branch, base_branch, labels_json, created_at, merged_at, closed_at, updated_at,
        head_sha, first_review_at, first_commit_authored_at, changed_files, commits_truncated,
        notes_truncated, jira_keys_json
      )
      SELECT
        ${row.projectId}, ${row.number}, ${row.authorContributorId}, ${row.authorLogin},
        ${row.state}, ${row.isDraft ? 1 : 0}, ${row.title}, ${row.headBranch}, ${row.baseBranch},
        ${JSON.stringify(row.labels)}, ${row.createdAt}, ${row.mergedAt}, ${row.closedAt},
        ${row.updatedAt}, ${row.headSha}, ${row.firstReviewAt}, ${row.firstCommitAuthoredAt},
        ${row.changedFiles}, ${row.commitsTruncated ? 1 : 0}, ${row.notesTruncated ? 1 : 0},
        ${JSON.stringify(row.jiraKeys)}
      WHERE EXISTS (
        SELECT 1 FROM fork_insights_contributors
        WHERE contributor_id = ${row.authorContributorId} AND status = 'included'
      ) AND EXISTS (
        SELECT 1 FROM fork_insights_projects WHERE project_id = ${row.projectId} AND enabled = 1
      )
      ON CONFLICT (project_id, number) DO UPDATE SET
        author_contributor_id = excluded.author_contributor_id,
        author_login = excluded.author_login,
        state = excluded.state,
        is_draft = excluded.is_draft,
        title = excluded.title,
        head_branch = excluded.head_branch,
        base_branch = excluded.base_branch,
        labels_json = excluded.labels_json,
        merged_at = excluded.merged_at,
        closed_at = excluded.closed_at,
        updated_at = excluded.updated_at,
        head_sha = excluded.head_sha,
        first_review_at = excluded.first_review_at,
        first_commit_authored_at = COALESCE(
          excluded.first_commit_authored_at,
          fork_insights_merge_requests.first_commit_authored_at
        ),
        changed_files = excluded.changed_files,
        commits_truncated = excluded.commits_truncated,
        notes_truncated = excluded.notes_truncated,
        jira_keys_json = excluded.jira_keys_json
    `.pipe(Effect.asVoid);

  const upsertReview: InsightsStore["Service"]["upsertReview"] = (input) =>
    sql`
      INSERT INTO fork_insights_mr_reviews (
        project_id, number, reviewer_contributor_id, kind, first_at
      )
      SELECT ${input.projectId}, ${input.number}, ${input.reviewerContributorId}, ${input.kind},
        ${input.firstAt}
      WHERE EXISTS (
        SELECT 1 FROM fork_insights_contributors
        WHERE contributor_id = ${input.reviewerContributorId} AND status = 'included'
      ) AND EXISTS (
        SELECT 1 FROM fork_insights_projects WHERE project_id = ${input.projectId} AND enabled = 1
      )
      ON CONFLICT (project_id, number, reviewer_contributor_id, kind) DO UPDATE SET
        first_at = MIN(fork_insights_mr_reviews.first_at, excluded.first_at)
    `.pipe(Effect.asVoid);

  const commitsBySha: InsightsStore["Service"]["commitsBySha"] = (projectId, shas) =>
    shas.length === 0
      ? Effect.succeed(new Map())
      : sql<CommitDbRow>`
          SELECT ${sql.literal(COMMIT_COLUMNS)} FROM fork_insights_commits
          WHERE project_id = ${projectId} AND sha IN ${sql.in(shas)}
        `.pipe(Effect.map((rows) => new Map(rows.map((row) => [row.sha, toStoredCommit(row)]))));

  const insertCommit: InsightsStore["Service"]["insertCommit"] = (row) =>
    sql`
      INSERT INTO fork_insights_commits (
        project_id, sha, contributor_id, author_email, authored_at, committed_at, mr_number,
        patch_id, additions, deletions, files_changed, file_mix, estimated_hours,
        estimate_method, landed_at, landed_branch, has_agent_coauthor, jira_keys_json,
        message_subject
      )
      SELECT
        ${row.projectId}, ${row.sha}, ${row.contributorId}, ${row.authorEmail}, ${row.authoredAt},
        ${row.committedAt}, ${row.mrNumber}, ${row.patchId}, ${row.additions}, ${row.deletions},
        ${row.filesChanged}, ${row.fileMix}, ${row.estimatedHours}, 'tier1', ${row.landedAt},
        ${row.landedBranch}, ${row.hasAgentCoauthor ? 1 : 0}, ${JSON.stringify(row.jiraKeys)},
        ${row.messageSubject}
      WHERE EXISTS (
        SELECT 1 FROM fork_insights_contributors
        WHERE contributor_id = ${row.contributorId} AND status = 'included'
      ) AND EXISTS (
        SELECT 1 FROM fork_insights_projects WHERE project_id = ${row.projectId} AND enabled = 1
      )
      ON CONFLICT (project_id, sha) DO UPDATE SET
        mr_number = COALESCE(fork_insights_commits.mr_number, excluded.mr_number),
        patch_id = COALESCE(fork_insights_commits.patch_id, excluded.patch_id)
    `.pipe(Effect.asVoid);

  const mergeRequestCommits: InsightsStore["Service"]["mergeRequestCommits"] = (
    projectId,
    number,
  ) =>
    sql<CommitDbRow>`
      SELECT ${sql.literal(COMMIT_COLUMNS)} FROM fork_insights_commits
      WHERE project_id = ${projectId} AND mr_number = ${number}
    `.pipe(Effect.map((rows) => rows.map(toStoredCommit)));

  const supersede: InsightsStore["Service"]["supersede"] = (projectId, sha, bySha) =>
    sql`
      UPDATE fork_insights_commits SET superseded_by_sha = ${bySha}
      WHERE project_id = ${projectId} AND sha = ${sha}
    `.pipe(Effect.asVoid);

  const markMergeRequestLanded: InsightsStore["Service"]["markMergeRequestLanded"] = (input) =>
    sql`
      UPDATE fork_insights_commits SET landed_at = ${input.landedAt}, landed_branch = ${input.branch}
      WHERE project_id = ${input.projectId} AND mr_number = ${input.number}
        AND landed_at IS NULL AND superseded_by_sha IS NULL
    `.pipe(Effect.asVoid);

  const markCommitLanded: InsightsStore["Service"]["markCommitLanded"] = (input) =>
    sql`
      UPDATE fork_insights_commits SET landed_at = ${input.landedAt}, landed_branch = ${input.branch}
      WHERE project_id = ${input.projectId} AND sha = ${input.sha} AND landed_at IS NULL
    `.pipe(Effect.asVoid);

  const unlandedCommitByPatchId: InsightsStore["Service"]["unlandedCommitByPatchId"] = (
    projectId,
    patchId,
  ) =>
    sql<CommitDbRow>`
      SELECT ${sql.literal(COMMIT_COLUMNS)} FROM fork_insights_commits
      WHERE project_id = ${projectId} AND patch_id = ${patchId}
        AND landed_at IS NULL AND superseded_by_sha IS NULL
      ORDER BY committed_at
      LIMIT 1
    `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : toStoredCommit(rows[0]))));

  const hasMergeRequestLandedNear: InsightsStore["Service"]["hasMergeRequestLandedNear"] = (
    input,
  ) => {
    const at = Date.parse(input.at);
    return sql<{ readonly found: number }>`
      SELECT 1 AS found FROM fork_insights_commits
      WHERE project_id = ${input.projectId} AND contributor_id = ${input.contributorId}
        AND mr_number IS NOT NULL
        AND landed_at BETWEEN ${isoOf(at - input.windowMs)}
          AND ${isoOf(at + input.windowMs)}
      LIMIT 1
    `.pipe(Effect.map((rows) => rows.length > 0));
  };

  const setFirstCommitAuthoredAt: InsightsStore["Service"]["setFirstCommitAuthoredAt"] = (
    projectId,
    number,
    authoredAt,
  ) =>
    sql`
      UPDATE fork_insights_merge_requests SET first_commit_authored_at = ${authoredAt}
      WHERE project_id = ${projectId} AND number = ${number}
        AND (first_commit_authored_at IS NULL OR first_commit_authored_at > ${authoredAt})
    `.pipe(Effect.asVoid);

  const overviewRows: InsightsStore["Service"]["overviewRows"] = Effect.fn(
    "InsightsStore.overviewRows",
  )(function* (input) {
    const filter = input.contributorIds;
    const contributorRows = yield* sql<{
      readonly contributor_id: string;
      readonly display_name: string | null;
      readonly gitlab_login: string | null;
      readonly kind: InsightsContributorKind;
      readonly email: string | null;
    }>`
        SELECT c.contributor_id, c.display_name, c.gitlab_login, c.kind,
          (SELECT MIN(email) FROM fork_insights_contributor_emails e
            WHERE e.contributor_id = c.contributor_id) AS email
        FROM fork_insights_contributors c
        WHERE c.status = 'included'
          ${filter === undefined ? sql`` : sql`AND c.contributor_id IN ${sql.in(filter.length === 0 ? [""] : filter)}`}
      `;
    const ids = contributorRows.map((row) => row.contributor_id);
    if (ids.length === 0) {
      return { contributors: [], commits: [], mergeRequests: [], reviews: [] };
    }
    const commits = yield* sql<{
      readonly contributor_id: string;
      readonly project_id: string;
      readonly mr_number: number | null;
      readonly authored_at: string;
      readonly landed_at: string | null;
      readonly estimated_hours: number;
      readonly superseded_by_sha: string | null;
      readonly message_subject: string;
      readonly has_agent_coauthor: number;
      readonly additions: number;
      readonly deletions: number;
    }>`
        SELECT contributor_id, project_id, mr_number, authored_at, landed_at, estimated_hours,
          superseded_by_sha, message_subject, has_agent_coauthor, additions, deletions
        FROM fork_insights_commits
        WHERE contributor_id IN ${sql.in(ids)}
          AND ((authored_at >= ${input.fromIso} AND authored_at < ${input.toIso})
            OR (landed_at >= ${input.fromIso} AND landed_at < ${input.toIso}))
      `;
    const mergeRequests = yield* sql<{
      readonly author_contributor_id: string;
      readonly project_id: string;
      readonly number: number;
      readonly state: string;
      readonly created_at: string;
      readonly merged_at: string | null;
      readonly closed_at: string | null;
      readonly first_review_at: string | null;
      readonly first_commit_authored_at: string | null;
      readonly changed_files: number | null;
    }>`
        SELECT author_contributor_id, project_id, number, state, created_at, merged_at, closed_at,
          first_review_at, first_commit_authored_at, changed_files
        FROM fork_insights_merge_requests
        WHERE author_contributor_id IN ${sql.in(ids)}
          AND ((created_at >= ${input.fromIso} AND created_at < ${input.toIso})
            OR (merged_at >= ${input.fromIso} AND merged_at < ${input.toIso})
            OR (closed_at >= ${input.fromIso} AND closed_at < ${input.toIso}))
      `;
    const reviews = yield* sql<{
      readonly reviewer_contributor_id: string;
      readonly project_id: string;
      readonly number: number;
      readonly first_at: string;
      readonly author_contributor_id: string | null;
    }>`
        SELECT r.reviewer_contributor_id, r.project_id, r.number, MIN(r.first_at) AS first_at,
          m.author_contributor_id
        FROM fork_insights_mr_reviews r
        LEFT JOIN fork_insights_merge_requests m
          ON m.project_id = r.project_id AND m.number = r.number
        WHERE r.reviewer_contributor_id IN ${sql.in(ids)}
          AND r.first_at >= ${input.fromIso} AND r.first_at < ${input.toIso}
        GROUP BY r.reviewer_contributor_id, r.project_id, r.number
      `;
    return {
      contributors: contributorRows.map((row) => ({
        contributorId: row.contributor_id,
        displayName: row.display_name ?? row.gitlab_login ?? row.email ?? row.contributor_id,
        kind: row.kind,
      })),
      commits: commits.map((row) => ({
        contributorId: row.contributor_id,
        authoredAt: row.authored_at,
        landedAt: row.landed_at,
        estimatedHours: row.estimated_hours,
        superseded: row.superseded_by_sha !== null,
        mergeRequestKey: row.mr_number === null ? null : `${row.project_id}:${row.mr_number}`,
        messageSubject: row.message_subject,
        hasAgentCoauthor: row.has_agent_coauthor !== 0,
        additions: row.additions,
        deletions: row.deletions,
      })),
      mergeRequests: mergeRequests.map((row) => ({
        authorContributorId: row.author_contributor_id,
        mergeRequestKey: `${row.project_id}:${row.number}`,
        number: row.number,
        state: row.state,
        createdAt: row.created_at,
        mergedAt: row.merged_at,
        closedAt: row.closed_at,
        firstReviewAt: row.first_review_at,
        firstCommitAuthoredAt: row.first_commit_authored_at,
        changedFiles: row.changed_files,
      })),
      reviews: reviews.map((row) => ({
        reviewerContributorId: row.reviewer_contributor_id,
        mergeRequestKey: `${row.project_id}:${row.number}`,
        mergeRequestNumber: row.number,
        authorContributorId: row.author_contributor_id,
        firstAt: row.first_at,
      })),
    };
  });

  return InsightsStore.of({
    settings,
    putSettings,
    projects,
    setProjectEnabled,
    resetCursors,
    saveProgress,
    contributors,
    contributor,
    contributorByEmail,
    ensureContributorByLogin,
    createContributorForEmail,
    addEmail,
    updateContributor,
    deleteContributorRows,
    mergeContributors,
    mergeRequestUpdatedAt,
    upsertMergeRequest,
    upsertReview,
    commitsBySha,
    insertCommit,
    mergeRequestCommits,
    supersede,
    markMergeRequestLanded,
    markCommitLanded,
    unlandedCommitByPatchId,
    hasMergeRequestLandedNear,
    setFirstCommitAuthoredAt,
    overviewRows,
  });
});

export const layer = Layer.effect(InsightsStore, make);
