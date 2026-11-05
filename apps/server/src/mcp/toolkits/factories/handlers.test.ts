import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type Factory,
  FactoryId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type WorkItem,
  WorkItemError,
  WorkItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as FactoryService from "../../../factories/FactoryService.ts";
import { builtinRoles } from "../../../factories/roles/index.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as FactoriesHandlers from "./handlers.ts";
import { FactoriesToolkit } from "./tools.ts";

const supervisedThreadId = ThreadId.make("thread:supervised");
const fullAccessThreadId = ThreadId.make("thread:full-access");
const shells = new Map([
  [supervisedThreadId, liveThreadShell(supervisedThreadId, { runtimeMode: "approval-required" })],
  [fullAccessThreadId, liveThreadShell(fullAccessThreadId)],
]);

const threadCaller = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const readOnlyClient: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Code", access: "read-only" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const factory: Factory = {
  id: FactoryId.make("factory:project-1:triage"),
  projectId: ProjectId.make("project-1"),
  name: "triage",
  definition: { name: "triage", projects: [], triggers: [], roles: {} },
  projects: [],
  roles: [
    {
      role: "foreman",
      path: null,
      source: "builtin",
      fileBinding: {},
      binding: builtinRoles.foreman.binding,
      body: builtinRoles.foreman.body,
      bodySource: "builtin",
      skills: [],
    },
  ],
  skills: [],
  issues: [],
  scheduledTaskIds: [],
  threads: [],
  attention: { gatesWaiting: 0, failedRuns: 0, questions: 0, total: 0 },
};

// The full-access thread is the work item's Foreman; the service decides that.
const foremanThreadId = fullAccessThreadId;
const workItem: WorkItem = {
  id: WorkItemId.make("work-item:1"),
  factoryId: factory.id,
  title: "Fix the login bug",
  source: { kind: "manual", text: "SSO fails." },
  stage: "new",
  gate: { state: "none" },
  foremanThreadId,
  foremanRunId: null,
  dispatchedAt: null,
  threads: [],
  createdAt: "2026-11-05T00:00:00.000Z",
  updatedAt: "2026-11-05T00:00:00.000Z",
  transitions: [],
};
const foremanOnly = (threadId: ThreadId, call: string, calls: Array<string>) =>
  threadId === foremanThreadId
    ? Effect.sync(() => calls.push(call)).pipe(Effect.as(workItem))
    : Effect.fail(new WorkItemError({ code: "not_foreman", message: "Not this item's Foreman." }));

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const decodeOutcome = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** Calls one tool and reports the failure code, or "ran" with the service calls it made. */
const call = (
  tool: string,
  scope: McpInvocationContext.McpInvocationScope,
  args: Record<string, unknown>,
) => {
  const calls: Array<string> = [];
  const service = Layer.mock(FactoryService.FactoryService)({
    list: () => Effect.sync(() => calls.push("list")).pipe(Effect.as({ factories: [] })),
    read: () => Effect.sync(() => calls.push("read")).pipe(Effect.as(factory)),
    save: () => Effect.sync(() => calls.push("save")).pipe(Effect.as(factory)),
    listWorkItems: () =>
      Effect.sync(() => calls.push("listWorkItems")).pipe(Effect.as({ workItems: [] })),
    createWorkItem: () => Effect.sync(() => calls.push("createWorkItem")).pipe(Effect.as(workItem)),
    advanceWorkItem: (threadId) => foremanOnly(threadId, "advanceWorkItem", calls),
    gateWorkItem: (threadId) => foremanOnly(threadId, "gateWorkItem", calls),
  });
  return McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: tool, arguments: args })),
    Effect.flatMap(({ content }) =>
      decodeOutcome(content.map((part) => (part.type === "text" ? part.text : "")).join("")),
    ),
    Effect.map((outcome) =>
      typeof outcome.code === "string" ? [outcome.code] : ["ran", ...calls],
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
    Effect.provide(
      McpHttpServer.toolkitRegistration(FactoriesToolkit, FactoriesHandlers.layer).pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(service),
        Layer.provideMerge(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
          }),
        ),
      ),
    ),
  );
};

const save = { projectId: "project-1", definition: factory.definition };
const create = { factoryId: factory.id, title: "Fix the login bug", text: "SSO fails." };
const advance = { workItemId: workItem.id, stage: "implement" };
const gate = { workItemId: workItem.id, question: "Ship it?", resumeStage: "done" };

it.effect.each([
  ["t3_factory_list", threadCaller(supervisedThreadId), {}, ["ran", "list"]],
  ["t3_factory_read", readOnlyClient, { factoryId: factory.id }, ["ran", "read"]],
  ["t3_factory_save", threadCaller(supervisedThreadId), save, ["capability_denied"]],
  ["t3_factory_save", readOnlyClient, save, ["capability_denied"]],
  ["t3_factory_save", threadCaller(fullAccessThreadId), save, ["ran", "save"]],
  ["t3_work_item_list", threadCaller(supervisedThreadId), {}, ["ran", "listWorkItems"]],
  // The Foreman runs full access, above a supervised caller.
  [
    "t3_work_item_create",
    threadCaller(supervisedThreadId),
    create,
    ["runtime_mode_escalation_denied"],
  ],
  ["t3_work_item_create", readOnlyClient, create, ["capability_denied"]],
  [
    "t3_work_item_create",
    threadCaller(fullAccessThreadId),
    create,
    ["ran", "read", "createWorkItem"],
  ],
  ["t3_work_item_advance", threadCaller(foremanThreadId), advance, ["ran", "advanceWorkItem"]],
  ["t3_work_item_advance", threadCaller(supervisedThreadId), advance, ["capability_denied"]],
  ["t3_work_item_gate", threadCaller(supervisedThreadId), gate, ["capability_denied"]],
] as const)("%s from %o: %o", ([tool, scope, args, expected]) =>
  call(tool, scope, args).pipe(Effect.map((outcome) => expect(outcome).toEqual(expected))),
);
