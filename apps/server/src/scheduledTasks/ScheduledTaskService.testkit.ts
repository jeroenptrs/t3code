import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTaskUpsertInput,
  type TriggerEvent,
  type TriggerJiraEventPayload,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

export const LAUNCHED_THREAD_ID = ThreadId.make("thread:launched");
const TRIGGER_PROJECT_ID = ProjectId.make("project:trigger");

/** The service over the ambient database, recording each launch and bound send it makes. */
export const makeScheduledTaskTestLayer = Effect.gen(function* () {
  const launches = yield* Queue.unbounded<ThreadLaunchService.ThreadLaunchInput>();
  const sends = yield* Queue.unbounded<ThreadManagementService.ThreadManagementSendInput>();
  const layer = ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ManagedPolicy.layerTest(),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Queue.offer(launches, input).pipe(
              Effect.as({ threadId: LAUNCHED_THREAD_ID, resumed: false } as never),
            ),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          sendToThread: (input) => Queue.offer(sends, input).pipe(Effect.as({} as never)),
          // A bound thread is checked on save; every bound thread here is live in the task's project.
          getThreadShell: () =>
            Effect.succeed({
              projectId: TRIGGER_PROJECT_ID,
              archivedAt: null,
              deletedAt: null,
            } as never),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        NodeCrypto.layer,
        Scheduler.layer,
      ),
    ),
  );
  return { launches, sends, layer };
});

export const taskInput = (
  overrides: Partial<ScheduledTaskUpsertInput> = {},
): ScheduledTaskUpsertInput => ({
  id: ScheduledTaskId.make("task:trigger"),
  title: "Triage",
  prompt: "Look at {{event.key}}",
  enabled: true,
  schedule: { type: "jira" },
  projectId: TRIGGER_PROJECT_ID,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  ...overrides,
});

export const jiraEvent = (
  overrides: Partial<Omit<TriggerJiraEventPayload, "type">> = {},
): TriggerEvent => ({
  source: "jira",
  type: "issue.status_changed",
  occurredAt: "2026-11-05T10:00:00.000Z",
  payload: {
    type: "issue.status_changed",
    site: "acme.atlassian.net",
    key: "PROJ-7",
    projectKey: "PROJ",
    url: "https://acme.atlassian.net/browse/PROJ-7",
    summary: "Fix login",
    status: "In Progress",
    statusCategory: "in-progress",
    previousStatus: "To Do",
    previousStatusCategory: "todo",
    issueType: "Bug",
    priority: null,
    assignee: null,
    assigneeAccountId: null,
    previousAssigneeAccountId: null,
    labels: [],
    addedLabels: [],
    removedLabels: [],
    ...overrides,
  },
});
