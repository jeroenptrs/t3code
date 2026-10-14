import {
  CommandId,
  MessageId,
  ThreadJiraIssueWatch,
  type JiraIssueSummary,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Notification,
  type ThreadJiraIssueSnapshot,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as JiraIdentities from "./JiraIdentities.ts";
import * as JiraService from "./JiraService.ts";
import { browseUrl } from "./issueMapping.ts";
import { evaluateJiraWatch, jiraWatchLostMessage, jiraWatchMessage } from "./jiraWatch.ts";
import { listActiveThreadJiraIssueLinks } from "./localLinks.ts";

const SYNC_INTERVAL = Duration.minutes(2);
/** A site that keeps failing is retried after 1, 2, 4, 8, then every 16 intervals. */
const MAX_BACKOFF_INTERVALS = 16;

type LinkRow = Effect.Success<ReturnType<typeof listActiveThreadJiraIssueLinks>>[number];

const linkId = (site: string, key: string) => `${site}\u0000${key}`;
const watchesEqual = Schema.toEquivalence(ThreadJiraIssueWatch);

function snapshotCurrent(
  snapshot: ThreadJiraIssueSnapshot | null,
  issue: JiraIssueSummary,
): boolean {
  return (
    snapshot !== null &&
    snapshot.summary === issue.summary &&
    snapshot.statusCategory === issue.statusCategory
  );
}

/**
 * Keeps the summary and status category on every thread's Jira links current. A sweep every two
 * minutes reads the visible links of active threads in one query, asks Jira once per site for
 * all of their keys, and records only the snapshots that changed. A new link is read right away.
 * Issues the reader cannot see keep their old snapshot, or none.
 *
 * The same read drives watches. A watched issue whose `updated` moved has its newest comments
 * read, once per issue however many threads watch it, and each watch records what it saw and
 * wakes its agent on a change. A watched issue the reader no longer sees ends its watches, and
 * so does a watch on a site with no identity, which is never read. Everything is read as the
 * site's service identity. Without Jira configured, one pass at start ends any watches left.
 */
export class JiraIssueSyncReactor extends Context.Service<
  JiraIssueSyncReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One sweep over every link; resolves once it has run. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/jira/JiraIssueSyncReactor") {}

const make = Effect.gen(function* () {
  const identities = yield* JiraIdentities.JiraIdentities;
  const jira = yield* JiraService.JiraService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const configuredSites = new Set(identities.list.map((identity) => identity.site));

  const failures = new Map<string, { readonly count: number; readonly retryAtMs: number }>();
  // Links seen without a snapshot wait here for one queued sweep, so a burst of links is read
  // together.
  const requested = new Set<string>();
  let requestedSweepQueued = false;

  const dispatchSync = (row: LinkRow, issue: JiraIssueSummary, syncedAt: string) =>
    Effect.gen(function* () {
      const uuid = yield* crypto.randomUUIDv4;
      yield* orchestrator.dispatch({
        type: "thread.jira-issue.sync",
        commandId: CommandId.make(`server:jira-sync:${row.threadId}:${uuid}`),
        threadId: row.threadId,
        site: row.site,
        key: row.key,
        snapshot: { summary: issue.summary, statusCategory: issue.statusCategory, syncedAt },
      });
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("Jira issue sync skipped", {
            threadId: row.threadId,
            key: row.key,
            cause: Cause.pretty(cause),
          }),
      ),
    );

  /**
   * Records what a watch saw, waking the agent when `wake` is set. The orchestrator applies it
   * only while the same watch is on, so a stop or restart that lands during the read wins.
   */
  const recordWatch = (
    row: LinkRow,
    watch: ThreadJiraIssueWatch,
    next: ThreadJiraIssueWatch | null,
    wake?: { readonly text: string; readonly notification: OrchestrationV2Notification },
  ) =>
    Effect.gen(function* () {
      const uuid = yield* crypto.randomUUIDv4;
      yield* orchestrator.dispatch({
        type: "thread.jira-issue-watch.sync",
        commandId: CommandId.make(`server:jira-watch:${row.threadId}:${uuid}`),
        threadId: row.threadId,
        site: row.site,
        key: row.key,
        startedAt: watch.startedAt,
        watch: next,
        ...(wake === undefined
          ? {}
          : { wake: { ...wake, messageId: MessageId.make(`message:jira-watch:${uuid}`) } }),
      });
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("Jira issue watch update skipped", {
            threadId: row.threadId,
            key: row.key,
            cause: Cause.pretty(cause),
          }),
      ),
    );

  const syncWatches = Effect.fn("JiraIssueSyncReactor.syncWatches")(function* (
    site: string,
    rows: ReadonlyArray<LinkRow>,
    byKey: ReadonlyMap<string, JiraIssueSummary>,
  ) {
    const comments = new Map<
      string,
      Effect.Success<ReturnType<JiraService.JiraService["Service"]["watchComments"]>> | null
    >();
    for (const row of rows) {
      const watch = row.watch;
      if (watch === null) continue;
      const issue = byKey.get(row.key);
      if (issue === undefined) {
        yield* recordWatch(
          row,
          watch,
          null,
          jiraWatchLostMessage({ key: row.key, url: browseUrl(site, row.key) }),
        );
        continue;
      }
      // A status or assignee change and a new comment all move `updated`.
      if (
        watch.updatedThrough !== null &&
        issue.updated !== null &&
        Date.parse(issue.updated) <= Date.parse(watch.updatedThrough)
      ) {
        continue;
      }
      if (!comments.has(row.key)) {
        comments.set(
          row.key,
          yield* jira.watchComments(site, row.key).pipe(
            Effect.catchTags({
              JiraError: (error) =>
                Effect.logWarning("Jira issue watch read failed", {
                  site,
                  key: row.key,
                  reason: error.reason,
                }).pipe(Effect.as(null)),
            }),
          ),
        );
      }
      // An unread issue is read again on the next sweep.
      const read = comments.get(row.key);
      if (read == null) continue;
      const report = evaluateJiraWatch(watch, { issue, ...read });
      if (report.changes.length === 0) {
        if (!watchesEqual(report.next, watch)) yield* recordWatch(row, watch, report.next);
        continue;
      }
      yield* recordWatch(
        row,
        watch,
        report.exhausted ? null : report.next,
        jiraWatchMessage({ key: row.key, summary: issue.summary, url: issue.url, report }),
      );
    }
  });

  const syncSite = Effect.fn("JiraIssueSyncReactor.syncSite")(function* (
    site: string,
    rows: ReadonlyArray<LinkRow>,
    now: DateTime.Utc,
  ) {
    const nowMs = DateTime.toEpochMillis(now);
    const failure = failures.get(site);
    if (failure !== undefined && failure.retryAtMs > nowMs) return;
    const issues = yield* jira.issuesByKeys(site, [...new Set(rows.map((row) => row.key))]).pipe(
      Effect.catchTags({
        JiraError: (error) => {
          const count = (failure?.count ?? 0) + 1;
          const intervals = Math.min(2 ** (count - 1), MAX_BACKOFF_INTERVALS);
          failures.set(site, {
            count,
            retryAtMs: nowMs + intervals * Duration.toMillis(SYNC_INTERVAL),
          });
          return Effect.logWarning("Jira issue sync failed", {
            site,
            reason: error.reason,
            failures: count,
          }).pipe(Effect.as(null));
        },
      }),
    );
    if (issues === null) return;
    failures.delete(site);
    const byKey = new Map(issues.map((issue) => [issue.key, issue]));
    const syncedAt = DateTime.formatIso(now);
    for (const row of rows) {
      const issue = byKey.get(row.key);
      if (issue === undefined || snapshotCurrent(row.snapshot, issue)) continue;
      yield* dispatchSync(row, issue, syncedAt);
    }
    yield* syncWatches(site, rows, byKey);
  });

  /** `requested` reads only links queued from events; `all` is the periodic sweep. */
  const run = Effect.fn("JiraIssueSyncReactor.run")(function* (scope: "all" | "requested") {
    let wanted: ReadonlySet<string> | null = null;
    if (scope === "requested") {
      // Requests from here on queue another sweep; the ones already recorded are read by this.
      requestedSweepQueued = false;
      wanted = new Set(requested);
      requested.clear();
    }
    const rows = yield* listActiveThreadJiraIssueLinks().pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    const relevant =
      wanted === null ? rows : rows.filter((row) => wanted.has(linkId(row.site, row.key)));
    // Nothing reads a site without an identity, so its watches would keep the thread working.
    yield* Effect.forEach(
      relevant,
      (row) =>
        row.watch !== null && !configuredSites.has(row.site)
          ? recordWatch(row, row.watch, null)
          : Effect.void,
      { discard: true },
    );
    const bySite = Map.groupBy(
      relevant.filter((row) => configuredSites.has(row.site)),
      (row) => row.site,
    );
    if (wanted === null) {
      // A site with no links left starts over without a backoff once one is linked again.
      for (const site of failures.keys()) if (!bySite.has(site)) failures.delete(site);
    }
    const now = yield* DateTime.now;
    yield* Effect.forEach(bySite, ([site, siteRows]) => syncSite(site, siteRows, now), {
      concurrency: 4,
      discard: true,
    });
  });

  const worker = yield* makeDrainableWorker((scope: "all" | "requested") =>
    run(scope).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("Jira issue sync sweep failed", { cause: Cause.pretty(cause) }),
      ),
    ),
  );

  const sweep: JiraIssueSyncReactor["Service"]["sweep"] = worker
    .enqueue("all")
    .pipe(Effect.andThen(worker.drain));

  const processEvent = (event: OrchestrationV2DomainEvent) => {
    if (event.type !== "thread.jira-issues-synced") return Effect.void;
    if (event.payload.archivedAt !== null || event.payload.deletedAt !== null) return Effect.void;
    for (const link of event.payload.jiraIssues ?? []) {
      if (link.snapshot === null && link.source !== "branch-dismissed") {
        requested.add(linkId(link.site, link.key));
      }
    }
    if (requested.size === 0 || requestedSweepQueued) return Effect.void;
    requestedSweepQueued = true;
    return worker.enqueue("requested");
  };

  const start: JiraIssueSyncReactor["Service"]["start"] = Effect.fn("JiraIssueSyncReactor.start")(
    function* () {
      // Configuration is fixed for the process, so one pass ends what an earlier one left.
      if (!identities.configured) return yield* forkParked(sweep);
      yield* forkParked(
        Stream.runForEach(orchestrator.streamDomainEvents, processEvent).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("Jira issue sync event stream failed", {
                cause: Cause.pretty(cause),
              }),
          ),
        ),
      );
      yield* forkParked(sweep.pipe(Effect.repeat(Schedule.spaced(SYNC_INTERVAL)), Effect.asVoid));
    },
  );

  return JiraIssueSyncReactor.of({ start, sweep });
});

export const layer = Layer.effect(JiraIssueSyncReactor, make);
