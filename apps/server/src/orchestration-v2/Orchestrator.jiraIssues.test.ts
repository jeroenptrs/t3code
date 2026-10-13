import { assert, it } from "@effect/vitest";
import {
  AuthUserId,
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ThreadJiraIssueLinkSource,
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
    }>`
      SELECT site, issue_key, source, linked_at, linked_by_user_id, snapshot_json
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
      })),
      (thread.jiraIssues ?? [])
        .map((entry) => ({
          site: entry.site,
          key: entry.key,
          source: entry.source,
          linkedAt: entry.linkedAt,
          linkedByUserId: entry.linkedByUserId ?? null,
          snapshot: entry.snapshot,
        }))
        .toSorted((left, right) => left.key.localeCompare(right.key)),
    );
  });

it.effect("links, deduplicates and unlinks a manual Jira issue", () =>
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

    yield* unlink(threadId, "ABC-1");
    assert.deepStrictEqual(yield* linkSummary(threadId), []);
    yield* assertForkRowsMatch(threadId);

    // Unlinking what is not linked changes nothing.
    yield* unlink(threadId, "ABC-1");
    assert.deepStrictEqual(yield* linkSummary(threadId), []);
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

it.effect("records a synced snapshot without marking the thread active", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:jira-sync");
    yield* createThread(threadId);
    yield* link(threadId, "ABC-3", "agent");
    const before = yield* readThread(threadId);

    yield* TestClock.adjust("1 second");
    yield* sync(threadId, "ABC-3");
    const after = yield* readThread(threadId);
    assert.deepStrictEqual(after.jiraIssues?.[0]?.snapshot, snapshot);
    assert.deepStrictEqual(after.updatedAt, before.updatedAt);
    yield* assertForkRowsMatch(threadId);

    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const shell = yield* projections.getThreadShell(threadId);
    assert.deepStrictEqual(shell?.jiraIssues, after.jiraIssues);

    // A sync for an issue the thread does not link is ignored.
    yield* sync(threadId, "ABC-99");
    assert.deepStrictEqual(yield* linkSummary(threadId), [[site, "ABC-3", "agent"]]);
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
    yield* maintenance.rebuild;
    assert.deepStrictEqual(
      (yield* countRows).map((row) => row.thread_id),
      [kept],
    );
    yield* assertForkRowsMatch(kept);
  }).pipe(Effect.provide(layerTest)),
);
