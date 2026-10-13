import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
  type ThreadJiraIssueLinkSource,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import type { JiraConfig } from "./JiraConfig.ts";

export const SITE = "acme.atlassian.net";
export const OTHER_SITE = "beta.atlassian.net";

export const jiraConfig: JiraConfig = {
  reader: "bot",
  identities: [
    {
      name: "bot",
      site: SITE,
      authMethod: "scoped-token",
      token: Redacted.make("token"),
      cloudId: "cloud-1",
    },
    {
      name: "beta",
      site: OTHER_SITE,
      authMethod: "scoped-token",
      token: Redacted.make("token"),
      cloudId: "cloud-2",
    },
  ],
};

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Jira links open no provider session"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;

/** Real orchestration on an in-memory database, for Jira code that reads and writes thread links. */
export const layerOrchestration = (name: string) =>
  Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ),
  );

let commandCount = 0;
const nextCommandId = (label: string) => CommandId.make(`test:${label}:${++commandCount}`);

export const createThread = (threadId: ThreadId, branch: string | null = null) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: nextCommandId("create"),
      threadId,
      projectId: ProjectId.make("project:jira"),
      title: "Started",
      modelSelection: { instanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    }),
  );

export const archiveThread = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.archive",
      commandId: nextCommandId("archive"),
      threadId,
    }),
  );

export const deleteThread = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({ type: "thread.delete", commandId: nextCommandId("delete"), threadId }),
  );

export const linkIssue = (
  threadId: ThreadId,
  key: string,
  source: ThreadJiraIssueLinkSource,
  site = SITE,
) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.jira-issue.link",
      commandId: nextCommandId("link"),
      threadId,
      site,
      key,
      source,
    }),
  );

export const unlinkIssue = (threadId: ThreadId, key: string, site = SITE) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.jira-issue.unlink",
      commandId: nextCommandId("unlink"),
      threadId,
      site,
      key,
    }),
  );

export const threadLinks = (threadId: ThreadId) =>
  Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
    projections.getThread(threadId).pipe(Effect.map((thread) => thread.jiraIssues ?? [])),
  );

/** Accepted commands whose id starts with `prefix`, so a test sees what a worker sent. */
export const jiraCommandIds = (prefix: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly command_id: string }>`
      SELECT command_id FROM orchestration_command_receipts
      WHERE status = 'accepted' AND command_id LIKE ${`${prefix}%`}
      ORDER BY result_sequence, command_id
    `.pipe(Effect.map((rows) => rows.map((row) => row.command_id))),
  );
