/**
 * JiraBreakdownThreads - which threads the server started to break a Jira issue into work
 * packages, read from `fork_jira_breakdowns`.
 *
 * Separate from `JiraBreakdownService` because provider sessions read it: the breakdown service
 * launches threads through orchestration, which opens provider sessions, so the session manager
 * cannot depend on it without a layer cycle.
 *
 * @module JiraBreakdownThreads
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

export class JiraBreakdownThreads extends Context.Service<
  JiraBreakdownThreads,
  {
    /** Whether the server started `threadId` as a breakdown; undefined when it cannot tell. */
    readonly isBreakdownThread: (threadId: ThreadId) => Effect.Effect<boolean | undefined>;
  }
>()("t3/jira/JiraBreakdownThreads") {}

/** Every provider session prepare asks; the threads a server touches between restarts fit. */
const CACHE_CAPACITY = 1_000;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The answer never changes once the thread exists: its row is inserted before the launch and
  // never removed. Failures are not kept, so the next prepare asks again.
  const answers = yield* Cache.makeWith(
    (threadId: ThreadId) =>
      sql<{ readonly found: number }>`
        SELECT 1 AS found FROM fork_jira_breakdowns WHERE thread_id = ${threadId}
      `.pipe(Effect.map((rows) => rows.length > 0)),
    {
      capacity: CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: () => Duration.infinity,
        onFailure: () => Duration.zero,
      }),
    },
  );

  const isBreakdownThread: JiraBreakdownThreads["Service"]["isBreakdownThread"] = (threadId) =>
    Cache.get(answers, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not read whether a thread is a Jira breakdown", {
          errorTag: error._tag,
        }).pipe(Effect.as(undefined)),
      ),
      Effect.withSpan("JiraBreakdownThreads.isBreakdownThread"),
    );

  return JiraBreakdownThreads.of({ isBreakdownThread });
});

export const layer = Layer.effect(JiraBreakdownThreads, make);
