/**
 * What transports call for Insights: the administrator's reads and configuration changes. The
 * ingestion itself is `InsightsIngestor`, run by the Scheduler.
 */
import {
  type AuthUserId,
  type InsightsConfig,
  type InsightsContributorMergeInput,
  type InsightsContributorUpdateInput,
  InsightsError,
  type InsightsOverview,
  type InsightsOverviewInput,
  type InsightsProject,
  type InsightsProjectEnabledInput,
  type InsightsProjectRescanInput,
  type InsightsSettingsUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as InsightsGit from "./insightsGit.ts";
import * as InsightsIngestor from "./InsightsIngestor.ts";
import { rollup } from "./insightsRollup.ts";
import * as InsightsStore from "./InsightsStore.ts";
import { isoOf } from "./isoTime.ts";

/** Longer windows than this are refused; they would read every row ever stored. */
const MAX_WINDOW_DAYS = 3 * 366;
const DAY_MS = 86_400_000;

type Actor = AuthUserId | null;

export class InsightsService extends Context.Service<
  InsightsService,
  {
    readonly overview: (
      input: InsightsOverviewInput,
    ) => Effect.Effect<InsightsOverview, InsightsError>;
    readonly config: Effect.Effect<InsightsConfig, InsightsError>;
    readonly updateSettings: (
      input: InsightsSettingsUpdateInput,
      actor: Actor,
    ) => Effect.Effect<InsightsConfig, InsightsError>;
    readonly setProjectEnabled: (
      input: InsightsProjectEnabledInput,
      actor: Actor,
    ) => Effect.Effect<InsightsConfig, InsightsError>;
    readonly rescanProject: (
      input: InsightsProjectRescanInput,
    ) => Effect.Effect<InsightsConfig, InsightsError>;
    readonly updateContributor: (
      input: InsightsContributorUpdateInput,
      actor: Actor,
    ) => Effect.Effect<InsightsConfig, InsightsError>;
    readonly mergeContributors: (
      input: InsightsContributorMergeInput,
    ) => Effect.Effect<InsightsConfig, InsightsError>;
  }
>()("t3/insights/InsightsService") {}

const unavailable = (cause: { readonly _tag: string }) =>
  Effect.logWarning("Insights could not read or write its state", { errorTag: cause._tag }).pipe(
    Effect.andThen(
      Effect.fail(
        new InsightsError({ reason: "unavailable", message: "Insights could not be read." }),
      ),
    ),
  );

const invalid = (message: string) => new InsightsError({ reason: "invalid", message });
const notFound = (message: string) => new InsightsError({ reason: "not-found", message });

const make = Effect.gen(function* () {
  const store = yield* InsightsStore.InsightsStore;
  const ingestor = yield* InsightsIngestor.InsightsIngestor;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const git = yield* GitVcsDriver.GitVcsDriver;

  /** T3 projects on this server whose remote is GitLab. */
  const gitLabProjects = pullRequests
    .providerProjects()
    .pipe(Effect.map((projects) => projects.filter((project) => project.api.kind === "gitlab")));

  const config: InsightsService["Service"]["config"] = Effect.gen(function* () {
    const [settings, rows, contributors, projects] = yield* Effect.all(
      [store.settings, store.projects, store.contributors, gitLabProjects],
      { concurrency: "unbounded" },
    );
    const byId = new Map(rows.map((row) => [row.projectId, row]));
    return {
      settings,
      projects: projects
        .map((project): InsightsProject => {
          const row = byId.get(project.project.id);
          return {
            projectId: project.project.id,
            title: project.project.title,
            host: project.host,
            repository: project.repository,
            enabled: row?.enabled ?? false,
            syncedThrough: row?.enabled === true ? row.mrCursor : null,
            lastSyncAt: row?.enabled === true ? row.lastSyncAt : null,
            lastError: row?.enabled === true ? row.lastError : null,
          };
        })
        .toSorted((a, b) => a.title.localeCompare(b.title)),
      contributors,
    };
  }).pipe(Effect.catch(unavailable));

  /** Moves cursors back so the next walks start at the start date and refetch everything. */
  const rescan = (projectIds?: ReadonlyArray<InsightsProject["projectId"]>) =>
    store.resetCursors(projectIds).pipe(
      Effect.andThen(
        projectIds === undefined
          ? ingestor.invalidate()
          : Effect.forEach(projectIds, (projectId) => ingestor.invalidate(projectId), {
              discard: true,
            }),
      ),
    );

  const overview: InsightsService["Service"]["overview"] = Effect.fn("InsightsService.overview")(
    function* (input) {
      const from = Date.parse(`${input.from}T00:00:00.000Z`);
      const to = Date.parse(`${input.to}T00:00:00.000Z`);
      if (Number.isNaN(from) || Number.isNaN(to) || to < from) {
        return yield* invalid("The window must end on or after the day it starts.");
      }
      if ((to - from) / DAY_MS > MAX_WINDOW_DAYS) {
        return yield* invalid("The window can be at most three years long.");
      }
      const today = isoOf(yield* Effect.clockWith((clock) => clock.currentTimeMillis)).slice(0, 10);
      const rows = yield* store
        .overviewRows({
          fromIso: isoOf(from),
          toIso: isoOf(to + DAY_MS),
          contributorIds: input.contributorIds,
        })
        .pipe(Effect.catch(unavailable));
      return rollup({ from: input.from, to: input.to, today, ...rows });
    },
  );

  const updateSettings: InsightsService["Service"]["updateSettings"] = Effect.fn(
    "InsightsService.updateSettings",
  )(function* (input, actor) {
    const previous = yield* store.settings.pipe(Effect.catch(unavailable));
    // Until saved, the start date is a default that moves with the clock; saving any setting
    // pins it.
    yield* store
      .putSettings({ ...input, startDate: input.startDate ?? previous.startDate }, actor)
      .pipe(Effect.catch(unavailable));
    // An earlier start date leaves a gap before every stored cursor; a later one changes nothing
    // already stored.
    if (input.startDate !== undefined && input.startDate < previous.startDate) {
      yield* rescan().pipe(Effect.catch(unavailable));
    }
    return yield* config;
  });

  const setProjectEnabled: InsightsService["Service"]["setProjectEnabled"] = Effect.fn(
    "InsightsService.setProjectEnabled",
  )(function* (input, actor) {
    const project = (yield* gitLabProjects.pipe(Effect.catch(unavailable))).find(
      (candidate) => candidate.project.id === input.projectId,
    );
    if (project === undefined) {
      return yield* notFound("That project is not on this server or its remote is not GitLab.");
    }
    yield* Effect.gen(function* () {
      // The start date bounds the first walk, so it is fixed once something is ingested.
      const settings = yield* store.settings;
      if (settings.updatedAt === null) {
        yield* store.putSettings({ startDate: settings.startDate }, actor);
      }
      yield* store.setProjectEnabled({
        projectId: input.projectId,
        host: project.host,
        repository: project.repository,
        enabled: input.enabled,
        userId: actor,
      });
    }).pipe(Effect.catch(unavailable));
    yield* ingestor.invalidate(input.projectId);
    if (!input.enabled) {
      yield* InsightsGit.pruneRefs({ cwd: project.project.workspaceRoot }).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, git),
        Effect.ignore({ log: true }),
      );
    }
    return yield* config;
  });

  const rescanProject: InsightsService["Service"]["rescanProject"] = Effect.fn(
    "InsightsService.rescanProject",
  )(function* (input) {
    const row = (yield* store.projects.pipe(Effect.catch(unavailable))).find(
      (candidate) => candidate.projectId === input.projectId,
    );
    if (row === undefined || !row.enabled) {
      return yield* notFound("Insights is not enabled for that project.");
    }
    yield* rescan([input.projectId]).pipe(Effect.catch(unavailable));
    return yield* config;
  });

  const updateContributor: InsightsService["Service"]["updateContributor"] = Effect.fn(
    "InsightsService.updateContributor",
  )(function* (input, actor) {
    const current = yield* store.contributor(input.contributorId).pipe(Effect.catch(unavailable));
    if (current === null) return yield* notFound("That contributor does not exist.");
    yield* store
      .updateContributor(
        input.contributorId,
        {
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        },
        actor,
      )
      .pipe(Effect.catch(unavailable));
    // Nothing was stored for them while they were not included, so their history is read again.
    if (input.status === "included" && current.status !== "included") {
      yield* rescan().pipe(Effect.catch(unavailable));
    }
    return yield* config;
  });

  const mergeContributors: InsightsService["Service"]["mergeContributors"] = Effect.fn(
    "InsightsService.mergeContributors",
  )(function* (input) {
    if (input.sourceContributorId === input.targetContributorId) {
      return yield* invalid("Pick two different contributors to merge.");
    }
    const [source, target] = yield* Effect.all([
      store.contributor(input.sourceContributorId),
      store.contributor(input.targetContributorId),
    ]).pipe(Effect.catch(unavailable));
    if (source === null || target === null) {
      return yield* notFound("That contributor does not exist.");
    }
    yield* store
      .mergeContributors(input.sourceContributorId, input.targetContributorId)
      .pipe(Effect.catch(unavailable));
    // The source's emails may name commits that were skipped while they were not included.
    if (target.status === "included" && source.status !== "included") {
      yield* rescan().pipe(Effect.catch(unavailable));
    }
    return yield* config;
  });

  return InsightsService.of({
    overview,
    config,
    updateSettings,
    setProjectEnabled,
    rescanProject,
    updateContributor,
    mergeContributors,
  });
});

export const layer = Layer.effect(InsightsService, make);
