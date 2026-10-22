/**
 * Fork-only Insights: estimated coding output per contributor, read from GitLab merge requests
 * through the provider API and from local git in each enabled project's checkout. Administrator
 * only; every number is a model estimate of coding output, not hours worked.
 */
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { AuthUserId } from "./authUser.ts";

const INSIGHTS_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A UTC calendar day, `YYYY-MM-DD`. */
export const InsightsDay = TrimmedNonEmptyString.check(Schema.isPattern(INSIGHTS_DAY_PATTERN));
export type InsightsDay = typeof InsightsDay.Type;

export const InsightsContributorId = TrimmedNonEmptyString.pipe(
  Schema.brand("InsightsContributorId"),
);
export type InsightsContributorId = typeof InsightsContributorId.Type;

/**
 * `pending` until an administrator decides. Only `included` contributors have commits, merge
 * requests and reviews stored; the others are an identity row and nothing else.
 */
export const InsightsContributorStatus = Schema.Literals(["pending", "included", "excluded"]);
export type InsightsContributorStatus = typeof InsightsContributorStatus.Type;

export const InsightsContributorKind = Schema.Literals(["human", "agent", "bot"]);
export type InsightsContributorKind = typeof InsightsContributorKind.Type;

export const InsightsContributor = Schema.Struct({
  contributorId: InsightsContributorId,
  displayName: Schema.NullOr(Schema.String),
  status: InsightsContributorStatus,
  kind: InsightsContributorKind,
  /** The portal user whose email matched, when one did. */
  userId: Schema.NullOr(AuthUserId),
  gitlabLogin: Schema.NullOr(Schema.String),
  emails: Schema.Array(Schema.String),
  firstSeenAt: IsoDateTime,
  decidedAt: Schema.NullOr(IsoDateTime),
});
export type InsightsContributor = typeof InsightsContributor.Type;

export const InsightsSettings = Schema.Struct({
  /** No provider call or git fetch asks for anything before this day. */
  startDate: InsightsDay,
  /** Branch globs besides the default branch that count as landed, such as `release/*`. */
  releaseBranchPatterns: Schema.Array(TrimmedNonEmptyString),
  /** Provider calls one ingestion tick may spend per host. */
  requestBudgetPerTick: PositiveInt,
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type InsightsSettings = typeof InsightsSettings.Type;

/** A T3 project on this server whose remote is GitLab. */
export const InsightsProject = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  host: Schema.String,
  repository: Schema.String,
  enabled: Schema.Boolean,
  /** Merge requests updated up to here are stored; null until the first full walk ends. */
  syncedThrough: Schema.NullOr(IsoDateTime),
  lastSyncAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
});
export type InsightsProject = typeof InsightsProject.Type;

export const InsightsConfig = Schema.Struct({
  settings: InsightsSettings,
  projects: Schema.Array(InsightsProject),
  contributors: Schema.Array(InsightsContributor),
});
export type InsightsConfig = typeof InsightsConfig.Type;

export const InsightsOverviewInput = Schema.Struct({
  /** Inclusive UTC days. */
  from: InsightsDay,
  to: InsightsDay,
  /** Omitted for every included contributor. */
  contributorIds: Schema.optional(Schema.Array(InsightsContributorId)),
});
export type InsightsOverviewInput = typeof InsightsOverviewInput.Type;

export const InsightsWeek = Schema.Struct({
  /** The Monday that starts the week. */
  weekStart: InsightsDay,
  pushedHours: Schema.Number,
  landedHours: Schema.Number,
  /** Contributors with at least one pushed or landed commit that week. */
  activeContributors: NonNegativeInt,
});
export type InsightsWeek = typeof InsightsWeek.Type;

export const InsightsContributorRow = Schema.Struct({
  contributorId: InsightsContributorId,
  displayName: Schema.String,
  kind: InsightsContributorKind,
  pushedHours: Schema.Number,
  landedHours: Schema.Number,
  /** Landed divided by pushed; null when nothing was pushed. */
  landedShare: Schema.NullOr(Schema.Number),
  /** Pushed hours divided by working days times eight, as a multiple. */
  throughput: Schema.Number,
  commits: NonNegativeInt,
  mergeRequestsMerged: NonNegativeInt,
  reviewsGiven: NonNegativeInt,
  medianFirstReviewHours: Schema.NullOr(Schema.Number),
  medianCycleHours: Schema.NullOr(Schema.Number),
});
export type InsightsContributorRow = typeof InsightsContributorRow.Type;

export const InsightsOverview = Schema.Struct({
  from: InsightsDay,
  to: InsightsDay,
  workingDays: NonNegativeInt,
  weeks: Schema.Array(InsightsWeek),
  contributors: Schema.Array(InsightsContributorRow),
});
export type InsightsOverview = typeof InsightsOverview.Type;

export const InsightsSettingsUpdateInput = Schema.Struct({
  startDate: Schema.optional(InsightsDay),
  releaseBranchPatterns: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  requestBudgetPerTick: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(200))),
});
export type InsightsSettingsUpdateInput = typeof InsightsSettingsUpdateInput.Type;

export const InsightsProjectEnabledInput = Schema.Struct({
  projectId: ProjectId,
  enabled: Schema.Boolean,
});
export type InsightsProjectEnabledInput = typeof InsightsProjectEnabledInput.Type;

export const InsightsProjectRescanInput = Schema.Struct({ projectId: ProjectId });
export type InsightsProjectRescanInput = typeof InsightsProjectRescanInput.Type;

export const InsightsContributorUpdateInput = Schema.Struct({
  contributorId: InsightsContributorId,
  /** Including queues a rescan of every enabled project; excluding deletes their rows. */
  status: Schema.optional(Schema.Literals(["included", "excluded"])),
  kind: Schema.optional(InsightsContributorKind),
  displayName: Schema.optional(TrimmedNonEmptyString),
});
export type InsightsContributorUpdateInput = typeof InsightsContributorUpdateInput.Type;

/** Moves the source's emails and rows onto the target and deletes the source. */
export const InsightsContributorMergeInput = Schema.Struct({
  sourceContributorId: InsightsContributorId,
  targetContributorId: InsightsContributorId,
});
export type InsightsContributorMergeInput = typeof InsightsContributorMergeInput.Type;

export class InsightsError extends Schema.TaggedError<InsightsError>()("InsightsError", {
  /** `invalid`: the request was rejected; `not-found`: no such project or contributor. */
  reason: Schema.Literals(["invalid", "not-found", "unavailable"]),
  message: Schema.String,
}) {}
