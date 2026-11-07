import {
  JiraIssueSummary,
  type PollTriggerStart,
  type ScheduledTaskId,
  ThreadPullRequestSnapshot,
  type TriggerEvent,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import {
  diffGitLabProjectsMergeRequest,
  diffPipeline,
  diffPullRequest,
  gitlabPipelineKey,
  GitLabPipelineState,
  gitlabTriggerKey,
  isFinishedPipeline,
  mergeRequestNumberOfRef,
  type PullRequestTriggerKey,
} from "./gitlabTriggerSource.ts";
import {
  diffJiraIssue,
  diffJiraQueryIssue,
  type JiraQueryWatchedField,
  jiraTriggerKey,
} from "./jiraTriggerSource.ts";

export class TriggerObservationError extends Schema.TaggedError<TriggerObservationError>()(
  "TriggerObservationError",
  {
    source: Schema.Literals(["jira", "gitlab", "jira_query", "gitlab_projects"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not record a ${this.source} trigger observation.`;
  }
}

/**
 * Turns what the Jira and pull request reactors read into trigger events. The last state seen
 * per key is stored, so a change made while the server was down still raises on the next read.
 * The first observation of a key raises nothing, except `merge_request.opened`.
 */
export class TriggerSources extends Context.Service<
  TriggerSources,
  {
    readonly observeJiraIssues: (
      site: string,
      issues: ReadonlyArray<JiraIssueSummary>,
    ) => Effect.Effect<void, TriggerObservationError>;
    /** Links on hosts other than GitLab are ignored. */
    readonly observePullRequest: (
      key: PullRequestTriggerKey,
      snapshot: ThreadPullRequestSnapshot,
    ) => Effect.Effect<void, TriggerObservationError>;
    /**
     * One poll of a Jira query trigger, its observations keyed by the trigger id. The first poll
     * raises `issue.entered` for the set only with `start: "current"`; a query change re-seeds
     * silently. A capped set raises no `issue.left`. `fireCurrent` raises entered for the set.
     */
    readonly observeJiraQuery: (input: {
      readonly triggerId: ScheduledTaskId;
      readonly start: PollTriggerStart;
      readonly fireCurrent: boolean;
      readonly query: string;
      readonly issues: ReadonlyArray<JiraIssueSummary>;
      readonly watchedFields: ReadonlySet<JiraQueryWatchedField>;
      readonly complete: boolean;
    }) => Effect.Effect<void, TriggerObservationError>;
    /** Where the last poll of a GitLab projects trigger left off; null before its first. */
    readonly gitLabProjectsMarker: (
      triggerId: ScheduledTaskId,
    ) => Effect.Effect<GitLabProjectsMarker | null, TriggerObservationError>;
    /**
     * One GitLab projects poll. The first raises `merge_request.opened` for open merge requests
     * only with `start: "current"`, and no pipeline events; a scope change re-seeds silently.
     * Ended work is forgotten after 30 days. `fireCurrent` raises opened for every open one.
     */
    readonly observeGitLabProjects: (input: {
      readonly triggerId: ScheduledTaskId;
      readonly start: PollTriggerStart;
      readonly fireCurrent: boolean;
      readonly host: string;
      readonly marker: GitLabProjectsMarker;
      readonly mergeRequests: ReadonlyArray<{
        readonly key: PullRequestTriggerKey;
        readonly snapshot: ThreadPullRequestSnapshot;
      }>;
      readonly pipelines: ReadonlyArray<GitLabPipelineState>;
    }) => Effect.Effect<void, TriggerObservationError>;
    readonly events: Stream.Stream<TriggerEvent>;
  }
>()("t3/triggers/TriggerSources") {}

/**
 * The projects or group a GitLab projects trigger read, and the newest `updated_at` it saw per
 * project (merge requests and pipelines) or group (merge requests), so a restart resumes there.
 */
export const GitLabProjectsMarker = Schema.Struct({
  scope: Schema.String,
  marks: Schema.Record(Schema.String, Schema.String),
});
export type GitLabProjectsMarker = typeof GitLabProjectsMarker.Type;

const RETENTION_DAYS = 30;

const JiraState = Schema.fromJsonString(JiraIssueSummary);
const decodeJiraState = Schema.decodeUnknownOption(JiraState);
const encodeJiraState = Schema.encodeSync(JiraState);
const PullRequestState = Schema.fromJsonString(ThreadPullRequestSnapshot);
const decodePullRequestState = Schema.decodeUnknownOption(PullRequestState);
const encodePullRequestState = Schema.encodeSync(PullRequestState);

const MarkerState = Schema.fromJsonString(GitLabProjectsMarker);
const decodeMarkerState = Schema.decodeUnknownOption(MarkerState);
const encodeMarkerState = Schema.encodeSync(MarkerState);
const PipelineState = Schema.fromJsonString(GitLabPipelineState);
const decodePipelineState = Schema.decodeUnknownOption(PipelineState);
const encodePipelineState = Schema.encodeSync(PipelineState);

const eventItemKey = (event: TriggerEvent) =>
  `${event.type}\u0000${
    "key" in event.payload
      ? event.payload.key
      : "repository" in event.payload
        ? `${event.payload.repository}\u0000${event.payload.number}`
        : ""
  }`;

/** The fired events a poll has not already raised for the same item and type. */
const raiseOnce = (raised: ReadonlyArray<TriggerEvent>, fired: ReadonlyArray<TriggerEvent>) => {
  const seen = new Set(raised.map(eventItemKey));
  return fired.filter((event) => {
    const key = eventItemKey(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const isGitLabLink = (url: string) =>
  sourceControlDefinitions.findByChangeRequestUrl(url)?.kind === "gitlab";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pubsub = yield* PubSub.unbounded<TriggerEvent>();
  // One pull request linked from several threads or projects is observed once per link; serial
  // observations see each other's writes, so a change raises once.
  const lock = yield* Semaphore.make(1);

  // Runs per issue or link inside the observe spans.
  const record = Effect.fnUntraced(function* (
    source: "jira" | "gitlab",
    key: string,
    stateJson: string,
    occurredAt: string,
    diff: (previousJson: string | null) => ReadonlyArray<TriggerEvent>,
  ) {
    const [row] = yield* sql<{ readonly state_json: string }>`
      SELECT state_json FROM fork_trigger_observations WHERE source = ${source} AND key = ${key}
    `;
    if (row?.state_json === stateJson) return [];
    yield* sql`
      INSERT INTO fork_trigger_observations (source, key, state_json, observed_at)
      VALUES (${source}, ${key}, ${stateJson}, ${occurredAt})
      ON CONFLICT (source, key) DO UPDATE SET
        state_json = excluded.state_json,
        observed_at = excluded.observed_at
    `;
    return diff(row?.state_json ?? null);
  });

  const commit = (
    source: "jira" | "gitlab" | "jira_query" | "gitlab_projects",
    work: Effect.Effect<ReadonlyArray<ReadonlyArray<TriggerEvent>>, SqlError.SqlError>,
  ) =>
    sql.withTransaction(work).pipe(
      lock.withPermits(1),
      Effect.mapError((cause) => new TriggerObservationError({ source, cause })),
      Effect.flatMap((events) => PubSub.publishAll(pubsub, events.flat())),
      Effect.asVoid,
    );

  const observeJiraIssues: TriggerSources["Service"]["observeJiraIssues"] = Effect.fn(
    "TriggerSources.observeJiraIssues",
  )(function* (site, issues) {
    yield* Effect.annotateCurrentSpan({ "jira.site": site, "trigger.observations": issues.length });
    const occurredAt = DateTime.formatIso(yield* DateTime.now);
    yield* commit(
      "jira",
      Effect.forEach(issues, (issue) =>
        record(
          "jira",
          jiraTriggerKey(site, issue.key),
          encodeJiraState(issue),
          occurredAt,
          (json) =>
            diffJiraIssue(
              json === null ? null : Option.getOrNull(decodeJiraState(json)),
              issue,
              occurredAt,
            ),
        ),
      ),
    );
  });

  const observePullRequest: TriggerSources["Service"]["observePullRequest"] = Effect.fn(
    "TriggerSources.observePullRequest",
  )(function* (key, snapshot) {
    if (!isGitLabLink(key.url)) return;
    const occurredAt = DateTime.formatIso(yield* DateTime.now);
    yield* commit(
      "gitlab",
      record(
        "gitlab",
        gitlabTriggerKey(key),
        encodePullRequestState(snapshot),
        occurredAt,
        (json) =>
          diffPullRequest(
            json === null ? null : Option.getOrNull(decodePullRequestState(json)),
            snapshot,
            key,
            occurredAt,
          ),
      ).pipe(Effect.map((events) => [events])),
    );
  });

  const observeJiraQuery: TriggerSources["Service"]["observeJiraQuery"] = Effect.fn(
    "TriggerSources.observeJiraQuery",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({
      "scheduled_task.id": input.triggerId,
      "trigger.observations": input.issues.length,
    });
    const occurredAt = DateTime.formatIso(yield* DateTime.now);
    // The marker row holds the query the stored set was read with.
    const marker = `${input.triggerId}\u0000`;
    const issueKey = (issue: JiraIssueSummary) =>
      `${marker}${jiraTriggerKey(issue.site, issue.key)}`;
    const work = Effect.gen(function* () {
      const rows = yield* sql<{ readonly key: string; readonly state_json: string }>`
        SELECT key, state_json FROM fork_trigger_observations
        WHERE source = 'jira_query' AND key >= ${marker} AND key < ${`${input.triggerId}\u0001`}
      `;
      const stored = new Map(rows.map((row) => [row.key, row.state_json]));
      const storedQuery = stored.get(marker);
      const seeding =
        storedQuery === undefined ? input.start === "changes" : storedQuery !== input.query;
      const events: Array<TriggerEvent> = [];
      const writes: Array<readonly [string, string]> = [];
      if (storedQuery !== input.query) writes.push([marker, input.query]);
      const context = { triggerId: input.triggerId, query: input.query, occurredAt };
      const current = new Set<string>();
      for (const issue of input.issues) {
        const key = issueKey(issue);
        current.add(key);
        const stateJson = encodeJiraState(issue);
        const previousJson = stored.get(key);
        if (previousJson === stateJson) continue;
        writes.push([key, stateJson]);
        if (seeding) continue;
        const previous =
          previousJson === undefined ? null : Option.getOrNull(decodeJiraState(previousJson));
        // An undecodable row is re-seeded rather than read as an entry.
        if (previousJson !== undefined && previous === null) continue;
        events.push(...diffJiraQueryIssue(previous, issue, input.watchedFields, context));
      }
      const left =
        seeding || input.complete
          ? [...stored.keys()].filter((key) => key !== marker && !current.has(key))
          : [];
      if (!seeding) {
        for (const key of left) {
          const previous = Option.getOrNull(decodeJiraState(stored.get(key)!));
          if (previous !== null) {
            events.push(...diffJiraQueryIssue(previous, null, input.watchedFields, context));
          }
        }
      }
      if (input.fireCurrent) {
        events.push(
          ...raiseOnce(
            events,
            input.issues.flatMap((issue) =>
              diffJiraQueryIssue(null, issue, input.watchedFields, context),
            ),
          ),
        );
      }
      const inserts: ReadonlyArray<Record<string, string>> = writes.map(([key, stateJson]) => ({
        source: "jira_query",
        key,
        state_json: stateJson,
        observed_at: occurredAt,
      }));
      if (Arr.isReadonlyArrayNonEmpty(inserts)) {
        yield* sql`
          INSERT INTO fork_trigger_observations ${sql.insert(inserts)}
          ON CONFLICT (source, key) DO UPDATE SET
            state_json = excluded.state_json,
            observed_at = excluded.observed_at
        `;
      }
      if (left.length > 0) {
        yield* sql`
          DELETE FROM fork_trigger_observations
          WHERE source = 'jira_query' AND key IN ${sql.in(left)}
        `;
      }
      return [events];
    });
    yield* commit("jira_query", work);
  });

  const gitLabProjectsMarker: TriggerSources["Service"]["gitLabProjectsMarker"] = Effect.fn(
    "TriggerSources.gitLabProjectsMarker",
  )(function* (triggerId) {
    const [row] = yield* sql<{ readonly state_json: string }>`
      SELECT state_json FROM fork_trigger_observations
      WHERE source = 'gitlab_projects' AND key = ${`${triggerId}\u0000`}
    `.pipe(
      Effect.mapError((cause) => new TriggerObservationError({ source: "gitlab_projects", cause })),
    );
    return row === undefined ? null : Option.getOrNull(decodeMarkerState(row.state_json));
  });

  const observeGitLabProjects: TriggerSources["Service"]["observeGitLabProjects"] = Effect.fn(
    "TriggerSources.observeGitLabProjects",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({
      "scheduled_task.id": input.triggerId,
      "trigger.observations": input.mergeRequests.length + input.pipelines.length,
    });
    const now = yield* DateTime.now;
    const occurredAt = DateTime.formatIso(now);
    const forgetBefore = DateTime.formatIso(DateTime.subtract(now, { days: RETENTION_DAYS }));
    const marker = `${input.triggerId}\u0000`;
    const context = { triggerId: input.triggerId, occurredAt };
    const work = Effect.gen(function* () {
      const rows = yield* sql<{
        readonly key: string;
        readonly state_json: string;
        readonly observed_at: string;
      }>`
        SELECT key, state_json, observed_at FROM fork_trigger_observations
        WHERE source = 'gitlab_projects'
          AND key >= ${marker} AND key < ${`${input.triggerId}\u0001`}
      `;
      const stored = new Map(rows.map((row) => [row.key, row]));
      const storedMarker = stored.get(marker);
      const previousScope =
        storedMarker === undefined
          ? null
          : (Option.getOrNull(decodeMarkerState(storedMarker.state_json))?.scope ?? "");
      // No marker: the first poll, which raises opened only from the current set. A different
      // scope re-seeds silently.
      const firstPoll = previousScope === null;
      const seeding = firstPoll ? input.start === "changes" : previousScope !== input.marker.scope;
      const events: Array<TriggerEvent> = [];
      const writes: Array<readonly [string, string]> = [[marker, encodeMarkerState(input.marker)]];

      // Merge requests by number and by open source branch, for the pipelines they ran.
      const mergeRequests = new Map<string, (typeof input.mergeRequests)[number]>();
      const openByBranch = new Map<string, (typeof input.mergeRequests)[number]>();
      const remember = (entry: (typeof input.mergeRequests)[number]) => {
        mergeRequests.set(`${entry.key.repository}\u0000${entry.key.number}`, entry);
        if (entry.snapshot.state === "open") {
          openByBranch.set(`${entry.key.repository}\u0000${entry.snapshot.headBranch}`, entry);
        }
      };
      const decodedMergeRequests = new Map<string, ThreadPullRequestSnapshot>();
      for (const row of rows) {
        if (row.key === marker || row.key.includes("\u0000pipeline\u0000")) continue;
        const snapshot = Option.getOrNull(decodePullRequestState(row.state_json));
        if (snapshot === null) continue;
        decodedMergeRequests.set(row.key, snapshot);
        const [, , repository = "", number = ""] = row.key.split("\u0000");
        remember({
          key: {
            host: input.host,
            repository,
            number: Number(number),
            url: `https://${input.host}/${repository}/-/merge_requests/${number}`,
          },
          snapshot,
        });
      }

      for (const entry of input.mergeRequests) {
        remember(entry);
        const key = `${marker}${gitlabTriggerKey(entry.key)}`;
        const stateJson = encodePullRequestState(entry.snapshot);
        const previousJson = stored.get(key)?.state_json;
        if (previousJson === stateJson) continue;
        writes.push([key, stateJson]);
        if (seeding) continue;
        const previous =
          previousJson === undefined ? null : (decodedMergeRequests.get(key) ?? null);
        // An undecodable row is re-seeded rather than read as an open.
        if (previousJson !== undefined && previous === null) continue;
        events.push(
          ...diffGitLabProjectsMergeRequest(previous, entry.snapshot, entry.key, context),
        );
      }

      for (const pipeline of input.pipelines) {
        const key = `${marker}${gitlabPipelineKey(input.host, pipeline.repository, pipeline.id)}`;
        const stateJson = encodePipelineState(pipeline);
        const previousJson = stored.get(key)?.state_json;
        if (previousJson === stateJson) continue;
        writes.push([key, stateJson]);
        if (seeding || firstPoll) continue;
        const previous =
          previousJson === undefined ? null : Option.getOrNull(decodePipelineState(previousJson));
        if (previousJson !== undefined && previous === null) continue;
        const number = mergeRequestNumberOfRef(pipeline.ref);
        const mergeRequest =
          (number === null
            ? openByBranch.get(`${pipeline.repository}\u0000${pipeline.ref}`)
            : mergeRequests.get(`${pipeline.repository}\u0000${number}`)) ?? null;
        events.push(...diffPipeline(previous, pipeline, mergeRequest, input.host, context));
      }

      if (input.fireCurrent) {
        events.push(
          ...raiseOnce(
            events,
            input.mergeRequests.flatMap((entry) =>
              entry.snapshot.state === "open"
                ? diffGitLabProjectsMergeRequest(null, entry.snapshot, entry.key, context)
                : [],
            ),
          ),
        );
      }

      // A re-seed drops what the old scope saw; otherwise ended work is forgotten after 30 days.
      const written = new Set(writes.map(([key]) => key));
      const forgotten = rows
        .filter((row) => !written.has(row.key) && row.key !== marker)
        .filter((row) => {
          if (seeding) return true;
          if (row.observed_at >= forgetBefore) return false;
          const snapshot = decodedMergeRequests.get(row.key);
          if (snapshot !== undefined) return snapshot.state !== "open";
          const pipeline = Option.getOrNull(decodePipelineState(row.state_json));
          return pipeline === null || isFinishedPipeline(pipeline);
        })
        .map((row) => row.key);

      const inserts: ReadonlyArray<Record<string, string>> = writes.map(([key, stateJson]) => ({
        source: "gitlab_projects",
        key,
        state_json: stateJson,
        observed_at: occurredAt,
      }));
      if (Arr.isReadonlyArrayNonEmpty(inserts)) {
        yield* sql`
          INSERT INTO fork_trigger_observations ${sql.insert(inserts)}
          ON CONFLICT (source, key) DO UPDATE SET
            state_json = excluded.state_json,
            observed_at = excluded.observed_at
        `;
      }
      if (forgotten.length > 0) {
        yield* sql`
          DELETE FROM fork_trigger_observations
          WHERE source = 'gitlab_projects' AND key IN ${sql.in(forgotten)}
        `;
      }
      return [events];
    });
    yield* commit("gitlab_projects", work);
  });

  return TriggerSources.of({
    observeJiraIssues,
    observeJiraQuery,
    gitLabProjectsMarker,
    observeGitLabProjects,
    observePullRequest,
    events: Stream.fromPubSub(pubsub),
  });
});

export const layer = Layer.effect(TriggerSources, make);
