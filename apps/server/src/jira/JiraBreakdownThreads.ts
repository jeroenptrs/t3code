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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

export class JiraBreakdownThreads extends Context.Service<
  JiraBreakdownThreads,
  {
    /** Whether the server started `threadId` as a breakdown; false when it cannot tell. */
    readonly isBreakdownThread: (threadId: ThreadId) => Effect.Effect<boolean>;
  }
>()("t3/jira/JiraBreakdownThreads") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const isBreakdownThread: JiraBreakdownThreads["Service"]["isBreakdownThread"] = (threadId) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found FROM fork_jira_breakdowns WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      // Without the answer the agent gets the ordinary Jira guidance, which is still correct.
      Effect.catch((error) =>
        Effect.logWarning("Could not read whether a thread is a Jira breakdown", {
          errorTag: error._tag,
        }).pipe(Effect.as(false)),
      ),
      Effect.withSpan("JiraBreakdownThreads.isBreakdownThread"),
    );

  return JiraBreakdownThreads.of({ isBreakdownThread });
});

export const layer = Layer.effect(JiraBreakdownThreads, make);
