import { JiraIssueSummary, ThreadPullRequestSnapshot, type TriggerEvent } from "@t3tools/contracts";
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
  diffPullRequest,
  gitlabTriggerKey,
  type PullRequestTriggerKey,
} from "./gitlabTriggerSource.ts";
import { diffJiraIssue, jiraTriggerKey } from "./jiraTriggerSource.ts";

export class TriggerObservationError extends Schema.TaggedError<TriggerObservationError>()(
  "TriggerObservationError",
  {
    source: Schema.Literals(["jira", "gitlab"]),
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
    readonly events: Stream.Stream<TriggerEvent>;
  }
>()("t3/triggers/TriggerSources") {}

const JiraState = Schema.fromJsonString(JiraIssueSummary);
const decodeJiraState = Schema.decodeUnknownOption(JiraState);
const encodeJiraState = Schema.encodeSync(JiraState);
const PullRequestState = Schema.fromJsonString(ThreadPullRequestSnapshot);
const decodePullRequestState = Schema.decodeUnknownOption(PullRequestState);
const encodePullRequestState = Schema.encodeSync(PullRequestState);

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
    source: "jira" | "gitlab",
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

  return TriggerSources.of({
    observeJiraIssues,
    observePullRequest,
    events: Stream.fromPubSub(pubsub),
  });
});

export const layer = Layer.effect(TriggerSources, make);
