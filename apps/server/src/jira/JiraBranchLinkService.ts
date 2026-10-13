import { CommandId, type OrchestrationV2DomainEvent, type ThreadId } from "@t3tools/contracts";
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

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import { jiraIssueKeyFromBranch } from "./issueKeys.ts";
import * as JiraIdentities from "./JiraIdentities.ts";
import * as JiraService from "./JiraService.ts";
import { listThreadBranchesForJira } from "./localLinks.ts";

/** The event triggers catch nearly every branch; the full pass retries what they missed. */
const FULL_SCAN_INTERVAL = Duration.minutes(10);
/** How long a branch key Jira did not answer under that key is remembered before asking again. */
const UNRESOLVED_KEY_TTL = Duration.hours(1);

/**
 * Links the Jira issue a thread's branch names, on the reader's site, as a `branch` link. A pass
 * runs over every active thread at start and ten minutes apart, and for one thread when it is
 * created, unarchived or its metadata changes. Each pass asks Jira once for all of its candidate
 * keys and links only issues that exist, so tokens like `gh-1234` or `node-20` stay unlinked.
 * Does nothing while Jira is unconfigured.
 */
export class JiraBranchLinkService extends Context.Service<
  JiraBranchLinkService,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One pass, for one thread or every active thread; resolves once it has run. */
    readonly scan: (threadId: ThreadId | null) => Effect.Effect<void>;
  }
>()("t3/jira/JiraBranchLinkService") {}

const make = Effect.gen(function* () {
  const identities = yield* JiraIdentities.JiraIdentities;
  const jira = yield* JiraService.JiraService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sql = yield* SqlClient.SqlClient;
  // Branch keys Jira did not return as asked: null when it returned nothing, else the key the
  // issue moved to. Remembered for a while so a stale branch does not query Jira every pass.
  const unresolved = new Map<
    string,
    { readonly key: string | null; readonly expiresAtMs: number }
  >();
  let failing = false;
  // Commands that were accepted or refused, so a later pass does not dispatch them again. The ids
  // are deterministic, so after a restart the orchestrator's receipt answers instead.
  const handled = new Set<string>();

  const link = (threadId: ThreadId, site: string, key: string) => {
    const commandId = CommandId.make(`server:jira-branch-link:${threadId}:${site}:${key}`);
    if (handled.has(commandId)) return Effect.void;
    return orchestrator
      .dispatch({
        type: "thread.jira-issue.link",
        commandId,
        threadId,
        site,
        key,
        source: "branch",
      })
      .pipe(
        Effect.tap(() => Effect.sync(() => handled.add(commandId))),
        Effect.asVoid,
        Effect.catchTags({
          // A thread deleted since the read; the refusal is final.
          OrchestratorCommandPreviouslyRejectedError: () =>
            Effect.sync(() => handled.add(commandId)),
        }),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("Jira branch link failed", {
              threadId,
              key,
              cause: Cause.pretty(cause),
            }),
        ),
      );
  };

  const synchronize = Effect.fn("JiraBranchLinkService.synchronize")(function* (
    threadId: ThreadId | null,
  ) {
    const reader = yield* identities.reader;
    const threads = yield* listThreadBranchesForJira(reader.site, threadId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    const nowMs = yield* Clock.currentTimeMillis;
    for (const [key, entry] of unresolved) if (entry.expiresAtMs <= nowMs) unresolved.delete(key);
    // A known moved key resolves without asking Jira again.
    const resolve = (key: string) => {
      const entry = unresolved.get(key);
      return entry === undefined ? key : entry.key;
    };
    const candidates = threads.flatMap((thread) => {
      const key = jiraIssueKeyFromBranch(thread.branch);
      const resolved = key === null ? null : resolve(key);
      return key === null || resolved === null || thread.linkedKeys.includes(resolved)
        ? []
        : [{ thread, key }];
    });
    const asked = new Set(candidates.flatMap(({ key }) => (unresolved.has(key) ? [] : [key])));
    if (asked.size > 0) {
      const issues = yield* jira.issuesByKeys(reader.site, [...asked]).pipe(
        Effect.catchTags({
          JiraError: (error) => {
            // Retried on the next pass; only the first failure in a row is worth a warning.
            const log = failing ? Effect.logDebug : Effect.logWarning;
            failing = true;
            return log("Jira branch link check failed", { reason: error.reason }).pipe(
              Effect.as(null),
            );
          },
        }),
      );
      if (issues === null) return;
      failing = false;
      const returned = new Set(issues.map((issue) => issue.key));
      const missing = [...asked].filter((key) => !returned.has(key));
      const extra = [...returned].filter((key) => !asked.has(key));
      // Jira answers a moved issue under its new key without saying which key was asked, so a
      // move is only recognized when it is the one unanswered key in the pass.
      const movedTo = missing.length === 1 && extra.length === 1 ? (extra[0] ?? null) : null;
      const expiresAtMs = nowMs + Duration.toMillis(UNRESOLVED_KEY_TTL);
      for (const key of missing) unresolved.set(key, { key: movedTo, expiresAtMs });
    }
    for (const { thread, key } of candidates) {
      const resolved = resolve(key);
      if (resolved === null || thread.linkedKeys.includes(resolved)) continue;
      yield* link(thread.threadId, reader.site, resolved);
    }
  });

  const worker = yield* makeDrainableWorker((threadId: ThreadId | null) =>
    synchronize(threadId).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("Jira branch scan failed", { cause: Cause.pretty(cause) }),
      ),
    ),
  );

  const scan: JiraBranchLinkService["Service"]["scan"] = (threadId) =>
    identities.configured
      ? worker.enqueue(threadId).pipe(Effect.andThen(worker.drain))
      : Effect.void;

  const processEvent = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "thread.created":
      case "thread.unarchived":
      case "thread.metadata-updated":
        return worker.enqueue(event.threadId);
    }
    return Effect.void;
  };

  const start: JiraBranchLinkService["Service"]["start"] = Effect.fn("JiraBranchLinkService.start")(
    function* () {
      if (!identities.configured) return;
      yield* forkParked(
        Stream.runForEach(orchestrator.streamDomainEvents, processEvent).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("Jira branch event stream failed", { cause: Cause.pretty(cause) }),
          ),
        ),
      );
      yield* forkParked(
        scan(null).pipe(Effect.repeat(Schedule.spaced(FULL_SCAN_INTERVAL)), Effect.asVoid),
      );
    },
  );

  return JiraBranchLinkService.of({ start, scan });
});

export const layer = Layer.effect(JiraBranchLinkService, make);
