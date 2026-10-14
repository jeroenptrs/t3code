import {
  ThreadId,
  type EnvironmentId,
  type JiraError,
  type OrchestrationV2DomainEvent,
  type ThreadJiraIssueLink,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
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
/** How long a site or project whose service identity may not write links is left alone. */
const NO_WRITE_ACCESS_PAUSE = Duration.hours(1);
/** Jira caps a remote link's title. */
const MAX_TITLE_LENGTH = 255;

interface RemoteLink {
  readonly site: string;
  readonly key: string;
  readonly title: string;
}
interface WrittenLink extends RemoteLink {
  readonly globalId: string;
}
type Links = ReadonlyMap<string, RemoteLink>;
type Work = "all" | { readonly threadId: ThreadId; readonly links: Links };

const linkId = (site: string, key: string) => `${site}\u0000${key}`;
/** A 403 is about the issue's project; another project on the site may still take links. */
const projectPauseId = (site: string, key: string) => linkId(site, key.split("-")[0] ?? key);

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

const decodeWrittenRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      site: Schema.String,
      key: Schema.String,
      globalId: Schema.String,
      title: Schema.String,
    }),
  ),
);

/**
 * Keeps a Jira remote link on every issue a thread links, pointing at the thread's public URL,
 * and removes it when the link goes or the thread is archived or deleted. Links are written as
 * the site's service identity, the one Jira write that carries no user intent, and only where it
 * may: a project that refuses (403) is left alone for an hour, and so is a whole site whose
 * credentials Jira rejects (401). Best effort; a failed write is retried by the next pass and
 * never affects the thread. Does nothing without Jira or a public URL.
 *
 * What was written is recorded in `fork_jira_remote_links` once Jira confirms it, and a row goes
 * only once Jira confirms the link is gone, so a link whose thread went away while the server was
 * down, or whose delete failed, is still removed after a restart.
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

  // The table's rows by thread, loaded by the first pass; null until then.
  let written: Map<ThreadId, Map<string, WrittenLink>> | null = null;
  // Keyed by site for a 401, by site and project for a 403.
  const pausedUntilMs = new Map<string, number>();
  const reported = new Set<string>();

  const loadWritten = Effect.gen(function* () {
    if (written !== null) return written;
    const rows = yield* sql`
      SELECT thread_id AS "threadId", site, issue_key AS key, global_id AS "globalId", title
      FROM fork_jira_remote_links
    `.pipe(Effect.flatMap(decodeWrittenRows));
    const loaded = new Map<ThreadId, Map<string, WrittenLink>>();
    for (const row of rows) {
      const links = loaded.get(row.threadId) ?? new Map<string, WrittenLink>();
      links.set(linkId(row.site, row.key), row);
      loaded.set(row.threadId, links);
    }
    written = loaded;
    return loaded;
  });

  const linksOf = (title: string, jiraIssues: ReadonlyArray<ThreadJiraIssueLink>): Links =>
    new Map(
      jiraIssues
        .filter((link) => link.source !== "branch-dismissed" && configuredSites.has(link.site))
        .map((link) => [
          linkId(link.site, link.key),
          { site: link.site, key: link.key, title: linkTitle(title) },
        ]),
    );

  const paused = (link: RemoteLink, nowMs: number) =>
    (pausedUntilMs.get(link.site) ?? 0) > nowMs ||
    (pausedUntilMs.get(projectPauseId(link.site, link.key)) ?? 0) > nowMs;

  /**
   * What Jira answered: `done`, `not-found` when the link is already gone or the identity
   * cannot see the issue at all, or `failed` to leave it for a later pass.
   */
  const write = (
    link: RemoteLink,
    request: (identity: JiraServerIdentity) => Effect.Effect<void, JiraError>,
  ) =>
    identities.forSite(link.site).pipe(
      Effect.flatMap(request),
      Effect.as("done" as const),
      Effect.catchTags({
        JiraError: (error) =>
          Effect.gen(function* () {
            switch (error.reason) {
              case "not-found":
                return "not-found" as const;
              case "unauthorized":
              case "forbidden": {
                const pauseId =
                  error.reason === "unauthorized" ? link.site : projectPauseId(link.site, link.key);
                const nowMs = yield* Clock.currentTimeMillis;
                pausedUntilMs.set(pauseId, nowMs + Duration.toMillis(NO_WRITE_ACCESS_PAUSE));
                const log = reported.has(pauseId) ? Effect.logDebug : Effect.logInfo;
                reported.add(pauseId);
                yield* log(
                  error.reason === "unauthorized"
                    ? "Jira remote links paused for an hour: Jira rejected the service identity"
                    : "Jira remote links paused for an hour in a project the service identity may not write links in",
                  {
                    site: link.site,
                    ...(error.reason === "forbidden"
                      ? { project: link.key.split("-")[0] ?? link.key }
                      : {}),
                  },
                );
                return "failed" as const;
              }
              default:
                yield* Effect.logDebug("Jira remote link write failed", {
                  site: link.site,
                  reason: error.reason,
                });
                return "failed" as const;
            }
          }),
      }),
    );

  const applyThread = Effect.fn("JiraRemoteLinkReactor.applyThread")(function* (
    publicOrigin: string,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    links: Links,
  ) {
    const all = yield* loadWritten;
    const current = new Map(all.get(threadId));
    const globalId = `t3code:${environmentId}:${threadId}`;
    const url = threadUrl(publicOrigin, environmentId, threadId);
    const iconUrl = `${publicOrigin}/favicon-16x16.png`;
    const nowMs = yield* Clock.currentTimeMillis;
    for (const [id, link] of links) {
      if (current.get(id)?.title === link.title || paused(link, nowMs)) continue;
      // An issue the identity cannot see yet is tried again by the next pass.
      const outcome = yield* write(link, (identity) =>
        api.upsertRemoteLink(identity, link.key, { globalId, url, title: link.title, iconUrl }),
      );
      if (outcome !== "done") continue;
      const writtenAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO fork_jira_remote_links (site, issue_key, thread_id, global_id, title, written_at)
        VALUES (${link.site}, ${link.key}, ${threadId}, ${globalId}, ${link.title}, ${writtenAt})
        ON CONFLICT (site, issue_key, thread_id)
        DO UPDATE SET global_id = excluded.global_id, title = excluded.title,
          written_at = excluded.written_at
      `;
      current.set(id, { ...link, globalId });
    }
    for (const [id, link] of current) {
      if (links.has(id) || paused(link, nowMs)) continue;
      const outcome = yield* write(link, (identity) =>
        api.deleteRemoteLink(identity, link.key, link.globalId),
      );
      if (outcome === "failed") continue;
      yield* sql`
        DELETE FROM fork_jira_remote_links
        WHERE site = ${link.site} AND issue_key = ${link.key} AND thread_id = ${threadId}
      `;
      current.delete(id);
    }
    if (current.size === 0) all.delete(threadId);
    else all.set(threadId, current);
  });

  const run = Effect.fn("JiraRemoteLinkReactor.run")(function* (work: Work) {
    if (origin === undefined) return;
    const environmentId = yield* environment.getEnvironmentId;
    if (work !== "all") {
      return yield* applyThread(origin, environmentId, work.threadId, work.links);
    }
    const all = yield* loadWritten;
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
    for (const threadId of all.keys()) {
      if (!byThread.has(threadId)) byThread.set(threadId, new Map());
    }
    yield* Effect.forEach(
      byThread,
      ([threadId, links]) =>
        sameLinks(all.get(threadId), links)
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
        if (written !== null && sameLinks(written.get(thread.id), links)) return Effect.void;
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
