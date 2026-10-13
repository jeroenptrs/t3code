import { CommandId, type OrchestrationV2DomainEvent, type ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
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
import { listThreadBranchesForJira } from "./localLinks.ts";

/**
 * Links the Jira issue a thread's branch names, on the reader's site, as a `branch` link. A pass
 * runs a minute apart over every active thread, and for one thread when it is created, unarchived
 * or its metadata changes. It never asks Jira: a key that does not exist stays linked without a
 * snapshot. Does nothing while Jira is unconfigured.
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
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sql = yield* SqlClient.SqlClient;
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
    for (const thread of threads) {
      const key = jiraIssueKeyFromBranch(thread.branch);
      if (key === null || thread.linkedKeys.includes(key)) continue;
      yield* link(thread.threadId, reader.site, key);
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
      yield* forkParked(scan(null).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid));
    },
  );

  return JiraBranchLinkService.of({ start, scan });
});

export const layer = Layer.effect(JiraBranchLinkService, make);
