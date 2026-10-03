import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadLaunchResult,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Orchestration V2 fixtures shared by this package's tests. */

const now = DateTime.makeUnsafe("2026-08-01T00:00:00.000Z");
const defaultModelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
};

export const projectShell = (
  id: string,
  overrides: Partial<OrchestrationProjectShell> = {},
): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot: `/workspace/${id}`,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

export const threadShell = (id: string, projectId = "project-a"): OrchestrationV2ThreadShell => {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make(projectId),
    title: id,
    providerInstanceId: defaultModelSelection.instanceId,
    modelSelection: defaultModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "server",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  };
};

export const shellSnapshot = (
  snapshotSequence: number,
  projects: ReadonlyArray<OrchestrationProjectShell>,
  threads: ReadonlyArray<OrchestrationV2ThreadShell> = [],
): OrchestrationV2ShellSnapshot => ({
  schemaVersion: 1,
  snapshotSequence,
  projects,
  threads,
  archivedThreads: [],
});

export const threadProjection = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly modelSelection?: ModelSelection;
  readonly messageIds?: ReadonlyArray<string>;
}): OrchestrationV2ThreadProjection => {
  const modelSelection = input.modelSelection ?? defaultModelSelection;
  return {
    thread: {
      id: input.threadId,
      projectId: input.projectId,
      title: "Existing thread title",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: input.threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "server",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: (input.messageIds ?? []).map((id) => ({
      id: MessageId.make(id),
      threadId: input.threadId,
      runId: null,
      nodeId: null,
      role: "user",
      text: "x",
      attachments: [],
      streaming: false,
      createdBy: "user",
      creationSource: "server",
      createdAt: now,
      updatedAt: now,
    })),
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
  };
};

export const threadSnapshot = (
  input: Parameters<typeof threadProjection>[0],
): OrchestrationV2ThreadDetailSnapshot => ({
  snapshotSequence: 3,
  projection: threadProjection(input),
});

export const launchResult = (
  input: Parameters<typeof threadProjection>[0] & { readonly resumed: boolean },
): OrchestrationV2ThreadLaunchResult => ({
  threadId: input.threadId,
  projection: threadProjection(input),
  resumed: input.resumed,
});
