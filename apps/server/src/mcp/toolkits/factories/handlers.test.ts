import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type Factory,
  FactoryId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as FactoryService from "../../../factories/FactoryService.ts";
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
  roles: [],
  issues: [],
  scheduledTaskIds: [],
  threads: [],
  attention: { gatesWaiting: 0, failedRuns: 0, questions: 0, total: 0 },
};

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

it.effect.each([
  ["t3_factory_list", threadCaller(supervisedThreadId), {}, ["ran", "list"]],
  ["t3_factory_read", readOnlyClient, { factoryId: factory.id }, ["ran", "read"]],
  ["t3_factory_save", threadCaller(supervisedThreadId), save, ["capability_denied"]],
  ["t3_factory_save", readOnlyClient, save, ["capability_denied"]],
  ["t3_factory_save", threadCaller(fullAccessThreadId), save, ["ran", "save"]],
] as const)("%s from %o: %o", ([tool, scope, args, expected]) =>
  call(tool, scope, args).pipe(Effect.map((outcome) => expect(outcome).toEqual(expected))),
);
