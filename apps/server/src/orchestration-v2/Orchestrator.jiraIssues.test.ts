import { assert, it } from "@effect/vitest";
import {
  AuthUserId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ThreadJiraIssueLinkSource,
  type ThreadJiraIssueWatch,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Linking a Jira issue opens no provider session"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProjectionMaintenance.layer.pipe(
    Layer.provide(
      Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(layerDatabase),
      ),
    ),
  ),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-jira-issues" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const site = "acme.atlassian.net";
const ada = AuthUserId.make("user-ada");
let commandCount = 0;
const nextCommandId = (label: string) => CommandId.make(`${label}:${++commandCount}`);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: nextCommandId("create"),
      threadId,
      projectId: ProjectId.make("project:thread-jira-issues"),
      title: "Started",
      modelSelection: { instanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const link = (
  threadId: ThreadId,
  key: string,
  source: ThreadJiraIssueLinkSource,
  linkedByUserId?: AuthUserId,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.jira-issue.link",
      commandId: nextCommandId("link"),
      threadId,
      site,
      key,
      source,
      ...(linkedByUserId === undefined ? {} : { linkedByUserId }),
    });
  });

const unlink = (threadId: ThreadId, key: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.jira-issue.unlink",
      commandId: nextCommandId("unlink"),
      threadId,
      site,
      key,
    });
  });

const snapshot = {
  summary: "Ship the read side",
  statusCategory: "in-progress" as const,
  syncedAt: "2026-10-13T12:00:00.000Z",
};

const sync = (threadId: ThreadId, key: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.jira-issue.sync",
      commandId: nextCommandId("sync"),
      threadId,
      site,
      key,
      snapshot,
    });
  });

const readThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return yield* projections.getThread(threadId);
  });

const linkSummary = (threadId: ThreadId) =>
  Effect.map(readThread(threadId), (thread) =>
    (thread.jiraIssues ?? []).map((entry) => [entry.site, entry.key, entry.source] as const),
  );

/** The fork reverse-lookup table must always match the thread payload. */
const assertForkRowsMatch = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const thread = yield* readThread(threadId);
    const rows = yield* sql<{
      readonly site: string;
      readonly issue_key: string;
      readonly source: string;
      readonly linked_at: string;
      readonly linked_by_user_id: string | null;
      readonly snapshot_json: string | null;
      readonly watch_json: string | null;
    }>`
      SELECT site, issue_key, source, linked_at, linked_by_user_id, snapshot_json, watch_json
      FROM fork_projection_thread_jira_issues
      WHERE thread_id = ${threadId}
      ORDER BY issue_key
    `;
    assert.deepStrictEqual(
      rows.map((row) => ({
        site: row.site,
        key: row.issue_key,
        source: row.source,
        linkedAt: row.linked_at,
        linkedByUserId: row.linked_by_user_id,
        snapshot: row.snapshot_json === null ? null : JSON.parse(row.snapshot_json),
        watch: row.watch_json === null ? null : JSON.parse(row.watch_json),
      })),
      (thread.jiraIssues ?? [])
        .map((entry) => ({
          site: entry.site,
          key: entry.key,
          source: entry.source,
          linkedAt: entry.linkedAt,
          linkedByUserId: entry.linkedByUserId ?? null,
          snapshot: entry.snapshot,
          watch: entry.watch ?? null,
        }))
        .toSorted((left, right) => left.key.localeCompare(right.key)),
    );
  });

it.effect("links, deduplicates and unlinks a manual Jira issue into a tombstone", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:jira-manual");
    yield* createThread(threadId);
    const createdAt = (yield* readThread(threadId)).updatedAt;

    // Site and key are normalized, so a second link in another case is a duplicate.
    yield* TestClock.adjust("1 second");
    yield* link(threadId, "abc-1", "manual", ada);
    const linked = yield* readThread(threadId);
    assert.deepStrictEqual(yield* linkSummary(threadId), [[site, "ABC-1", "manual"]]);
    assert.equal(linked.jiraIssues?.[0]?.linkedByUserId, ada);
    assert.isNull(linked.jiraIssues?.[0]?.snapshot);
    assert.isTrue(DateTime.toEpochMillis(linked.updatedAt) > DateTime.toEpochMillis(createdAt));
    yield* assertForkRowsMatch(threadId);

    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.jira-issue.link",
      commandId: nextCommandId("link"),
      threadId,
      site: "ACME.atlassian.net",
      key: "ABC-1",
      source: "agent",
    });
    assert.deepStrictEqual(yield* linkSummary(threadId), [[site, "ABC-1", "manual"]]);
    assert.equal((yield* readThread(threadId)).jiraIssues?.[0]?.linkedByUserId, ada);

    // Any unlink leaves a tombstone, so a branch naming the key cannot bring it back.
    yield* unlink(threadId, "ABC-1");
    assert.deepStrictEqual(yield* linkSummary(threadId), [[site, "ABC-1", "branch-dismissed"]]);
    yield* assertForkRowsMatch(threadId);
    yield* link(threadId, "ABC-1", "branch");
    assert.deepStrictEqual(yield* linkSummary(threadId), [[site, "ABC-1", "branch-dismissed"]]);

    // Unlinking what is not linked changes nothing.
    const before = yield* readThread(threadId);
    yield* unlink(threadId, "ABC-1");
    yield* unlink(threadId, "ABC-9");
    assert.deepStrictEqual(yield* readThread(threadId), before);

    // An agent link revives the tombstone.
    yield* link(threadId, "ABC-1", "agent");
    assert.deepStrictEqual(yield* linkSummary(threadId), [[site, "ABC-1", "agent"]]);
    yield* assertForkRowsMatch(threadId);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps a dismissed branch link as a tombstone that only a manual link revives", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:jira-branch");
    yield* createThread(threadId);
    yield* link(threadId, "ABC-2", "branch");
    yield* sync(threadId, "ABC-2");

    yield* unlink(threadId, "ABC-2");
    const dismissed = yield* readThread(threadId);
    assert.deepStrictEqual(yield* linkSummary(threadId), [[site, "ABC-2", "branch-dismissed"]]);
    assert.deepStrictEqual(dismissed.jiraIssues?.[0]?.snapshot, snapshot);
    yield* assertForkRowsMatch(threadId);

    // The branch detector noticing the key again must not revive it.
    yield* link(threadId, "ABC-2", "branch");
    assert.deepStrictEqual(yield* linkSummary(threadId), [[site, "ABC-2", "branch-dismissed"]]);

    // Unlinking a tombstone and syncing it both change nothing.
    yield* unlink(threadId, "ABC-2");
    yield* sync(threadId, "ABC-2");
    assert.deepStrictEqual(yield* readThread(threadId), dismissed);

    yield* link(threadId, "ABC-2", "manual", ada);
    const revived = yield* readThread(threadId);
    assert.deepStrictEqual(yield* linkSummary(threadId), [[site, "ABC-2", "manual"]]);
    assert.equal(revived.jiraIssues?.[0]?.linkedByUserId, ada);
    yield* assertForkRowsMatch(threadId);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("records branch links and synced snapshots without marking the thread active", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:jira-sync");
    yield* createThread(threadId);
    const created = yield* readThread(threadId);
    yield* TestClock.adjust("1 second");
    yield* link(threadId, "ABC-5", "branch");
    assert.deepStrictEqual((yield* readThread(threadId)).updatedAt, created.updatedAt);

    yield* link(threadId, "ABC-3", "agent");
    const before = yield* readThread(threadId);

    yield* TestClock.adjust("1 second");
    yield* sync(threadId, "ABC-3");
    const after = yield* readThread(threadId);
    assert.deepStrictEqual(after.jiraIssues?.[1]?.snapshot, snapshot);
    assert.deepStrictEqual(after.updatedAt, before.updatedAt);
    yield* assertForkRowsMatch(threadId);

    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const shell = yield* projections.getThreadShell(threadId);
    assert.deepStrictEqual(shell?.jiraIssues, after.jiraIssues);

    // A sync for an issue the thread does not link is ignored.
    yield* sync(threadId, "ABC-99");
    assert.deepStrictEqual(yield* linkSummary(threadId), [
      [site, "ABC-5", "branch"],
      [site, "ABC-3", "agent"],
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("drops a deleted thread's rows and restores them on a projection rebuild", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const kept = ThreadId.make("thread:jira-kept");
    const deleted = ThreadId.make("thread:jira-deleted");
    yield* createThread(kept);
    yield* createThread(deleted);
    yield* link(kept, "ABC-4", "manual", ada);
    yield* sync(kept, "ABC-4");
    yield* link(deleted, "ABC-4", "manual");
    // A later thread event supersedes the Jira ones, so compaction drops them.
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: nextCommandId("rename"),
      threadId: kept,
      title: "Renamed",
    });

    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: nextCommandId("delete"),
      threadId: deleted,
    });
    const countRows = sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM fork_projection_thread_jira_issues
      WHERE site = ${site} AND issue_key = 'ABC-4'
    `;
    assert.deepStrictEqual(
      (yield* countRows).map((row) => row.thread_id),
      [kept],
    );

    yield* sql`DELETE FROM fork_projection_thread_jira_issues`;
    const compacted = yield* maintenance.compactEventStore;
    assert.isAbove(compacted.deletedEventCount, 0);
    yield* maintenance.rebuild;
    assert.deepStrictEqual(
      (yield* countRows).map((row) => row.thread_id),
      [kept],
    );
    yield* assertForkRowsMatch(kept);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("leaves the reverse-lookup rows alone on a thread event that is not about Jira", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:jira-untouched");
    yield* createThread(threadId);
    yield* link(threadId, "ABC-6", "manual");
    yield* assertForkRowsMatch(threadId);

    // A marker the projection would overwrite if it rewrote the rows.
    yield* sql`
      UPDATE fork_projection_thread_jira_issues SET linked_at = 'marker'
      WHERE thread_id = ${threadId}
    `;
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: nextCommandId("rename"),
      threadId,
      title: "Renamed",
    });
    const rows = yield* sql<{ readonly linked_at: string }>`
      SELECT linked_at FROM fork_projection_thread_jira_issues WHERE thread_id = ${threadId}
    `;
    assert.deepStrictEqual(
      rows.map((row) => row.linked_at),
      ["marker"],
    );
  }).pipe(Effect.provide(layerTest)),
);

const watch = (
  threadId: ThreadId,
  key: string,
  watching: boolean,
  link?: { readonly linkSource: "manual" | "agent"; readonly linkedByUserId?: AuthUserId },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.jira-issue.watch",
      commandId: nextCommandId("watch"),
      threadId,
      site,
      key,
      watching,
      ...link,
    });
  });

const recordWatch = (
  threadId: ThreadId,
  key: string,
  startedAt: string,
  next: ThreadJiraIssueWatch | null,
  wakeText?: string,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const commandId = nextCommandId("watch-sync");
    yield* orchestrator.dispatch({
      type: "thread.jira-issue-watch.sync",
      commandId,
      threadId,
      site,
      key,
      startedAt,
      watch: next,
      ...(wakeText === undefined
        ? {}
        : {
            wake: {
              messageId: MessageId.make(`message:${commandId}`),
              text: wakeText,
              notification: {
                source: { kind: "monitor" as const },
                outcome: "updated" as const,
                summary: `${key}: new comments`,
              },
            },
          }),
    });
  });

const watchOf = (threadId: ThreadId, key: string) =>
  Effect.map(
    readThread(threadId),
    (thread) => thread.jiraIssues?.find((entry) => entry.key === key)?.watch,
  );

const messagesOf = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator
      .getThreadRecords(threadId, ["messages"])
      .pipe(Effect.map((records) => records.messages)),
  );

it.effect("watching links the issue first, records progress, and stops", () =>
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const threadId = ThreadId.make("thread:jira-watch");
    yield* createThread(threadId);
    yield* TestClock.adjust("1 second");
    yield* watch(threadId, "abc-10", true, { linkSource: "manual", linkedByUserId: ada });
    const linked = (yield* readThread(threadId)).jiraIssues?.[0];
    assert.deepStrictEqual(
      [linked?.key, linked?.source, linked?.linkedByUserId],
      ["ABC-10", "manual", ada],
    );
    const started = linked?.watch;
    assert.isDefined(started);
    if (started === undefined) return;
    assert.deepStrictEqual(started, {
      startedAt: started.startedAt,
      updatedThrough: null,
      statusCategory: null,
      assigneeAccountId: null,
      commentsThrough: started.startedAt,
      wakes: 0,
    });
    yield* assertForkRowsMatch(threadId);
    const shell = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadShell(threadId);
    assert.deepStrictEqual(shell?.pendingBackgroundTasks, [
      {
        taskId: `jira-issue-watch:${site}/ABC-10`,
        description: "Watching Jira issue ABC-10",
        kind: "monitor",
      },
    ]);

    // Watching again keeps the running watch.
    yield* watch(threadId, "ABC-10", true, { linkSource: "agent" });
    assert.deepStrictEqual(yield* watchOf(threadId, "ABC-10"), started);

    const before = yield* readThread(threadId);
    yield* TestClock.adjust("1 second");
    const recorded = {
      ...started,
      updatedThrough: "2026-10-14T10:00:00.000Z",
      statusCategory: "todo" as const,
      assigneeAccountId: "account-ada",
    };
    yield* recordWatch(threadId, "ABC-10", started.startedAt, recorded);
    assert.deepStrictEqual(yield* watchOf(threadId, "ABC-10"), recorded);
    // Recorded progress is bookkeeping, not thread activity.
    assert.deepStrictEqual((yield* readThread(threadId)).updatedAt, before.updatedAt);
    yield* assertForkRowsMatch(threadId);
    assert.isTrue((yield* maintenance.rebuild).valid);
    assert.deepStrictEqual(yield* watchOf(threadId, "ABC-10"), recorded);
    yield* assertForkRowsMatch(threadId);

    yield* watch(threadId, "ABC-10", false);
    assert.isUndefined(yield* watchOf(threadId, "ABC-10"));
    assert.deepStrictEqual(yield* linkSummary(threadId), [[site, "ABC-10", "manual"]]);
    yield* assertForkRowsMatch(threadId);

    // A read from before the stop neither wakes the agent nor brings the watch back.
    const late = yield* recordWatch(
      threadId,
      "ABC-10",
      started.startedAt,
      { ...recorded, wakes: 1 },
      "Update",
    ).pipe(Effect.flip);
    assert.equal(late._tag, "OrchestratorDispatchError");
    assert.isUndefined(yield* watchOf(threadId, "ABC-10"));
    assert.deepStrictEqual(yield* messagesOf(threadId), []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("starts without a status baseline and refuses an issue the thread does not link", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:jira-watch-refused");
    yield* createThread(threadId);
    const refused = yield* watch(threadId, "ABC-11", true).pipe(Effect.flip);
    assert.equal(refused._tag, "OrchestratorDispatchError");
    assert.deepStrictEqual(yield* linkSummary(threadId), []);

    yield* link(threadId, "ABC-11", "branch");
    yield* sync(threadId, "ABC-11");
    yield* watch(threadId, "ABC-11", true);
    // The snapshot may predate the watch, so the first read sets the status baseline.
    assert.isNull((yield* watchOf(threadId, "ABC-11"))?.statusCategory);

    // Unlinking ends the watch; an unlinked issue is watched only by linking it again.
    yield* unlink(threadId, "ABC-11");
    assert.isUndefined(yield* watchOf(threadId, "ABC-11"));
    assert.deepStrictEqual(yield* linkSummary(threadId), [[site, "ABC-11", "branch-dismissed"]]);
    yield* assertForkRowsMatch(threadId);
    const dismissed = yield* watch(threadId, "ABC-11", true).pipe(Effect.flip);
    assert.equal(dismissed._tag, "OrchestratorDispatchError");
    yield* watch(threadId, "ABC-11", true, { linkSource: "agent" });
    assert.deepStrictEqual(yield* linkSummary(threadId), [[site, "ABC-11", "agent"]]);
    assert.isDefined(yield* watchOf(threadId, "ABC-11"));
    yield* assertForkRowsMatch(threadId);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a wake queues a message for the agent with the watch it recorded", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:jira-watch-wake");
    yield* createThread(threadId);
    yield* watch(threadId, "ABC-12", true, { linkSource: "agent" });
    const started = yield* watchOf(threadId, "ABC-12");
    if (started === undefined) return assert.fail("the watch did not start");

    // A read for a watch that was restarted since is refused.
    const stale = yield* recordWatch(
      threadId,
      "ABC-12",
      "2026-01-01T00:00:00.000Z",
      started,
      "x",
    ).pipe(Effect.flip);
    assert.equal(stale._tag, "OrchestratorDispatchError");

    const next = { ...started, wakes: 1, commentsThrough: "2026-10-14T10:04:00.000Z" };
    yield* recordWatch(threadId, "ABC-12", started.startedAt, next, "Update on Jira issue ABC-12");
    assert.deepStrictEqual(yield* watchOf(threadId, "ABC-12"), next);
    const messages = yield* messagesOf(threadId);
    assert.deepStrictEqual(
      messages.map((message) => [message.text, message.createdBy, message.notification?.summary]),
      [["Update on Jira issue ABC-12", "agent", "ABC-12: new comments"]],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["archive", "settle", "stop"] as const)(
  "%s ends the thread's Jira watches",
  (action) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make(`thread:jira-watch-${action}`);
      yield* createThread(threadId);
      yield* watch(threadId, "ABC-13", true, { linkSource: "agent" });
      yield* watch(threadId, "ABC-14", true, { linkSource: "manual" });
      const started = yield* watchOf(threadId, "ABC-13");
      if (started === undefined) return assert.fail("the watch did not start");

      yield* orchestrator.dispatch(
        action === "archive"
          ? { type: "thread.archive", commandId: nextCommandId(action), threadId }
          : action === "settle"
            ? { type: "thread.settle", commandId: nextCommandId(action), threadId }
            : { type: "thread.stop", commandId: nextCommandId(action), threadId },
      );
      const thread = yield* readThread(threadId);
      assert.deepStrictEqual(
        thread.jiraIssues?.map((entry) => [entry.key, entry.watch]),
        [
          ["ABC-13", undefined],
          ["ABC-14", undefined],
        ],
      );
      yield* assertForkRowsMatch(threadId);
      const late = yield* recordWatch(threadId, "ABC-13", started.startedAt, started, "x").pipe(
        Effect.flip,
      );
      assert.equal(late._tag, "OrchestratorDispatchError");
      assert.deepStrictEqual(yield* messagesOf(threadId), []);

      // A settled or archived thread takes no new watch; Stop only ends the running ones.
      if (action === "stop") return;
      const restart = yield* watch(threadId, "ABC-13", true, { linkSource: "agent" }).pipe(
        Effect.flip,
      );
      assert.equal(restart._tag, "OrchestratorDispatchError");
    }).pipe(Effect.provide(layerTest)),
);
