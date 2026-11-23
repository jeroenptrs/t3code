import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { IssueTrackerKind, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import {
  SITE,
  createThread,
  layerOrchestration,
  linkIssue,
  threadLinks,
} from "../jira/JiraLinks.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadIssueService from "./ThreadIssueService.ts";

const THREAD_ID = ThreadId.make("thread-1");

describe("ThreadIssueService", () => {
  it.effect("fails an unlink whose thread cannot be read instead of reporting it unlinked", () =>
    Effect.gen(function* () {
      const service = yield* ThreadIssueService.ThreadIssueService;
      const error = yield* service
        .unlink({
          threadId: THREAD_ID,
          key: {
            tracker: IssueTrackerKind.make("github"),
            host: "github.com",
            scope: "t3tools/t3code",
            key: "7",
          },
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "OrchestratorProjectionError", threadId: THREAD_ID });
    }).pipe(
      Effect.provide(
        ThreadIssueService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              SqlitePersistence.layerMemory,
              Layer.mock(Orchestrator.OrchestratorV2)({
                getThreadShell: (threadId) =>
                  Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
              }),
              Layer.succeed(
                SecureRandom.SecureRandom,
                SecureRandom.make((size) => new Uint8Array(size).fill(7)),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  // Fork: a Jira issue is linked in `thread.jiraIssues`, and the neutral answers read it there.
  it.effect("links, finds and unlinks a Jira issue in the Jira link store", () =>
    Effect.gen(function* () {
      const service = yield* ThreadIssueService.ThreadIssueService;
      const sql = yield* SqlClient.SqlClient;
      const linked = ThreadId.make("thread:linked");
      const dismissed = ThreadId.make("thread:dismissed");
      const legacy = ThreadId.make("thread:legacy");
      const key = {
        tracker: IssueTrackerKind.make("jira"),
        host: SITE,
        scope: "ABC",
        key: "ABC-1",
      };
      const input = (threadId: ThreadId) => ({
        threadId,
        ref: { ...key, projectId: ProjectId.make("project:jira") },
        url: `https://${SITE}/browse/ABC-1`,
        displayKey: "ABC-1",
        title: "Ship it",
        source: "agent" as const,
      });
      const linkedIds = Effect.map(service.linkedThreads(key), (result) =>
        result.threads.map((thread) => thread.id),
      );
      yield* createThread(linked);
      yield* createThread(dismissed);
      yield* createThread(legacy);

      expect(yield* service.link(input(linked))).toEqual({ alreadyLinked: false });
      expect(yield* service.link(input(linked))).toEqual({ alreadyLinked: true });
      expect((yield* threadLinks(linked)).map((link) => [link.key, link.source])).toEqual([
        ["ABC-1", "agent"],
      ]);
      // The fork's own link is the same link to the neutral service.
      yield* linkIssue(dismissed, "ABC-1", "branch");
      expect(yield* service.link(input(dismissed))).toEqual({ alreadyLinked: true });
      expect((yield* linkedIds).toSorted()).toEqual([dismissed, linked].toSorted());

      expect(yield* service.unlink({ threadId: dismissed, key })).toEqual({ wasLinked: true });
      expect(yield* service.unlink({ threadId: dismissed, key })).toEqual({ wasLinked: false });
      expect((yield* threadLinks(dismissed)).map((link) => link.source)).toEqual([
        "branch-dismissed",
      ]);
      expect(yield* linkedIds).toEqual([linked]);

      // A neutral Jira link stored before the routing existed is unlinked where it is stored.
      const stored = {
        ...key,
        projectId: "project:jira",
        url: `https://${SITE}/browse/ABC-1`,
        source: "agent",
        linkedAt: "2026-11-22T00:00:00.000Z",
        displayKey: "ABC-1",
        title: "Ship it",
      };
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.issues', json(${JSON.stringify([stored])}))
        WHERE thread_id = ${legacy}
      `;
      expect(yield* service.unlink({ threadId: legacy, key })).toEqual({ wasLinked: true });
      expect(yield* service.unlink({ threadId: legacy, key })).toEqual({ wasLinked: false });
      expect(yield* threadLinks(legacy)).toEqual([]);
    }).pipe(
      Effect.provide(
        ThreadIssueService.layer.pipe(
          Layer.provide(NodeCrypto.layer),
          Layer.provideMerge(layerOrchestration("thread-issue-service")),
        ),
      ),
    ),
  );
});
