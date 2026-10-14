import type {
  EnvironmentId,
  JiraError,
  OrchestrationV2DomainEvent,
  ThreadId,
  ThreadJiraIssueLink,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import type { JiraServerIdentity } from "./JiraConfig.ts";
import * as JiraApi from "./JiraApi.ts";
import * as JiraIdentities from "./JiraIdentities.ts";
import { listActiveThreadJiraRemoteLinks } from "./localLinks.ts";

/** Events catch nearly every change; the full pass converges what they missed or failed. */
const RECONCILE_INTERVAL = Duration.minutes(10);
/** How long a site whose service identity may not write links is left alone. */
const NO_WRITE_ACCESS_PAUSE = Duration.hours(1);
/** Jira caps a remote link's title. */
const MAX_TITLE_LENGTH = 255;

interface RemoteLink {
  readonly site: string;
  readonly key: string;
  readonly title: string;
}
type Links = ReadonlyMap<string, RemoteLink>;
type Work = "all" | { readonly threadId: ThreadId; readonly links: Links };

const linkId = (site: string, key: string) => `${site}\u0000${key}`;

const linkTitle = (threadTitle: string) => {
  const title = `T3 Code: ${threadTitle}`;
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
};

/** The web route `/$environmentId/$threadId` on the public origin. */
const threadUrl = (origin: string, environmentId: EnvironmentId, threadId: ThreadId) =>
  `${origin}/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;

const sameLinks = (left: Links | undefined, right: Links) =>
  (left?.size ?? 0) === right.size &&
  [...right].every(([id, link]) => left?.get(id)?.title === link.title);

/**
 * Keeps a Jira remote link on every issue a thread links, pointing at the thread's public URL,
 * and removes it when the link goes or the thread is archived or deleted. Links are written as
 * the site's service identity, the one Jira write that carries no user intent, and only where it
 * may: a site that refuses is left alone for an hour. Best effort; a failed write is retried by
 * the next pass and never affects the thread. Does nothing without Jira or a public URL.
 *
 * What was written is remembered in memory, so a restart re-upserts every link once (Jira
 * updates a link by its `globalId`) and cannot remove one whose unlink failed before it.
 */
export class JiraRemoteLinkReactor extends Context.Service<
  JiraRemoteLinkReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One pass over every active thread's links; resolves once it has run. */
    readonly reconcile: Effect.Effect<void>;
  }
>()("t3/jira/JiraRemoteLinkReactor") {}

const make = Effect.gen(function* () {
  const identities = yield* JiraIdentities.JiraIdentities;
  const api = yield* JiraApi.JiraApi;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const sql = yield* SqlClient.SqlClient;
  const origin = (yield* ServerConfig.ServerConfig).entraSignIn?.publicUrl.origin;
  const enabled = identities.configured && origin !== undefined;
  const configuredSites = new Set(identities.list.map((identity) => identity.site));

  const written = new Map<ThreadId, Map<string, RemoteLink>>();
  const pausedUntilMs = new Map<string, number>();
  const reportedSites = new Set<string>();

  const linksOf = (title: string, jiraIssues: ReadonlyArray<ThreadJiraIssueLink>): Links =>
    new Map(
      jiraIssues
        .filter((link) => link.source !== "branch-dismissed" && configuredSites.has(link.site))
        .map((link) => [
          linkId(link.site, link.key),
          { site: link.site, key: link.key, title: linkTitle(title) },
        ]),
    );

  /** Whether the write landed, or has nothing left to do; false leaves it for a later pass. */
  const write = (
    site: string,
    request: (identity: JiraServerIdentity) => Effect.Effect<void, JiraError>,
  ) =>
    identities.forSite(site).pipe(
      Effect.flatMap(request),
      Effect.as(true),
      Effect.catchTags({
        JiraError: (error) =>
          Effect.gen(function* () {
            switch (error.reason) {
              // The link is already gone, or the identity cannot see the issue at all.
              case "not-found":
                return true;
              case "unauthorized":
              case "forbidden": {
                const nowMs = yield* Clock.currentTimeMillis;
                pausedUntilMs.set(site, nowMs + Duration.toMillis(NO_WRITE_ACCESS_PAUSE));
                const log = reportedSites.has(site) ? Effect.logDebug : Effect.logInfo;
                reportedSites.add(site);
                yield* log(
                  "Jira remote links paused for an hour: the service identity may not write them",
                  { site, reason: error.reason },
                );
                return false;
              }
              default:
                yield* Effect.logDebug("Jira remote link write failed", {
                  site,
                  reason: error.reason,
                });
                return false;
            }
          }),
      }),
    );

  const paused = (site: string, nowMs: number) => (pausedUntilMs.get(site) ?? 0) > nowMs;

  const applyThread = Effect.fn("JiraRemoteLinkReactor.applyThread")(function* (
    publicOrigin: string,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    links: Links,
  ) {
    const current = new Map(written.get(threadId));
    const globalId = `t3code:${environmentId}:${threadId}`;
    const url = threadUrl(publicOrigin, environmentId, threadId);
    const iconUrl = `${publicOrigin}/favicon-16x16.png`;
    const nowMs = yield* Clock.currentTimeMillis;
    for (const [id, link] of links) {
      if (current.get(id)?.title === link.title || paused(link.site, nowMs)) continue;
      const done = yield* write(link.site, (identity) =>
        api.upsertRemoteLink(identity, link.key, { globalId, url, title: link.title, iconUrl }),
      );
      if (done) current.set(id, link);
    }
    for (const [id, link] of current) {
      if (links.has(id) || paused(link.site, nowMs)) continue;
      const done = yield* write(link.site, (identity) =>
        api.deleteRemoteLink(identity, link.key, globalId),
      );
      if (done) current.delete(id);
    }
    if (current.size === 0) written.delete(threadId);
    else written.set(threadId, current);
  });

  const run = Effect.fn("JiraRemoteLinkReactor.run")(function* (work: Work) {
    if (origin === undefined) return;
    const environmentId = yield* environment.getEnvironmentId;
    if (work !== "all") {
      return yield* applyThread(origin, environmentId, work.threadId, work.links);
    }
    const rows = yield* listActiveThreadJiraRemoteLinks().pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    const byThread = new Map<ThreadId, Map<string, RemoteLink>>();
    for (const row of rows) {
      if (!configuredSites.has(row.site)) continue;
      const links = byThread.get(row.threadId) ?? new Map<string, RemoteLink>();
      links.set(linkId(row.site, row.key), {
        site: row.site,
        key: row.key,
        title: linkTitle(row.title),
      });
      byThread.set(row.threadId, links);
    }
    // Threads written before but gone from the active list were unlinked, archived or deleted.
    for (const threadId of written.keys()) {
      if (!byThread.has(threadId)) byThread.set(threadId, new Map());
    }
    yield* Effect.forEach(
      byThread,
      ([threadId, links]) =>
        sameLinks(written.get(threadId), links)
          ? Effect.void
          : applyThread(origin, environmentId, threadId, links),
      { concurrency: 4, discard: true },
    );
  });

  const worker = yield* makeDrainableWorker((work: Work) =>
    run(work).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("Jira remote link pass failed", { cause: Cause.pretty(cause) }),
      ),
    ),
  );

  const reconcile: JiraRemoteLinkReactor["Service"]["reconcile"] = enabled
    ? worker.enqueue("all").pipe(Effect.andThen(worker.drain))
    : Effect.void;

  const processEvent = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "thread.created":
      case "thread.archived":
      case "thread.unarchived":
      case "thread.deleted":
      case "thread.metadata-updated":
      case "thread.jira-issues-synced": {
        const thread = event.payload;
        const links =
          thread.archivedAt === null && thread.deletedAt === null
            ? linksOf(thread.title, thread.jiraIssues ?? [])
            : new Map<string, RemoteLink>();
        // Snapshot syncs and unrelated metadata changes leave the links as written.
        if (sameLinks(written.get(thread.id), links)) return Effect.void;
        return worker.enqueue({ threadId: thread.id, links });
      }
    }
    return Effect.void;
  };

  const start: JiraRemoteLinkReactor["Service"]["start"] = Effect.fn("JiraRemoteLinkReactor.start")(
    function* () {
      if (!enabled) return;
      yield* forkParked(
        Stream.runForEach(orchestrator.streamDomainEvents, processEvent).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("Jira remote link event stream failed", {
                cause: Cause.pretty(cause),
              }),
          ),
        ),
      );
      yield* forkParked(
        reconcile.pipe(Effect.repeat(Schedule.spaced(RECONCILE_INTERVAL)), Effect.asVoid),
      );
    },
  );

  return JiraRemoteLinkReactor.of({ start, reconcile });
});

export const layer = Layer.effect(JiraRemoteLinkReactor, make);
