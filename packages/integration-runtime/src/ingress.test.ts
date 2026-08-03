import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  type ClientOrchestrationCommand,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
  type ServerConfig,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { buildThreadDeepLink, startStandardIngress } from "./ingress.ts";
import { INGRESS_IDENTITY_VERSION, type IngressRequest } from "./model.ts";
import { T3TransportError, type T3Transport } from "./transport.ts";

const projectId = ProjectId.make("project-main");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
};
const request: IngressRequest = {
  invocation: {
    identityVersion: INGRESS_IDENTITY_VERSION,
    integration: "slack",
    tenantId: "T123",
    surface: "slash",
    invocationId: "stable-invocation",
    prompt: `  ${"Investigate a deliberately long build failure prompt ".repeat(2)}  `,
  },
  target: { projectId, modelSelection: null },
  requestedAt: "2026-07-31T10:00:00.000Z",
};

const shell = {
  snapshotSequence: 1,
  projects: [
    {
      id: projectId,
      title: "T3 Code",
      workspaceRoot: "/workspace/t3code",
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
  ],
  threads: [],
  updatedAt: "2026-07-31T10:00:00.000Z",
} as unknown as OrchestrationShellSnapshot;

const config = {
  environment: { environmentId: EnvironmentId.make("environment-main") },
  providers: [
    {
      instanceId: modelSelection.instanceId,
      enabled: true,
      installed: true,
      availability: "available",
      status: "ready",
      auth: { status: "authenticated" },
      models: [{ slug: modelSelection.model }, { slug: "gpt-5-integration" }],
    },
  ],
} as unknown as ServerConfig;

const threadSnapshot = (
  threadId: ThreadId,
  messageIds: ReadonlyArray<string>,
): OrchestrationThreadDetailSnapshot =>
  ({
    snapshotSequence: 3,
    thread: {
      id: threadId,
      projectId,
      title: "Existing thread title",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      messages: messageIds.map((id) => ({ id: MessageId.make(id), role: "user", text: "x" })),
    },
  }) as unknown as OrchestrationThreadDetailSnapshot;

const makeTransport = (input?: {
  readonly snapshots?: ReadonlyArray<OrchestrationThreadDetailSnapshot | null>;
  readonly dispatchResults?: ReadonlyArray<T3TransportError | null>;
}) => {
  const commands: Array<ClientOrchestrationCommand> = [];
  const snapshots = [...(input?.snapshots ?? [null])];
  const dispatchResults = [...(input?.dispatchResults ?? [])];
  const transport: T3Transport = {
    close: () => Effect.void,
    validateSession: () => Effect.succeed({ authenticated: true, auth: {} as never, scopes: [] }),
    getShellSnapshot: () => Effect.succeed(shell),
    subscribeShell: () => Stream.never,
    getServerConfig: () => Effect.succeed(config),
    getThreadSnapshot: () => Effect.succeed(snapshots.shift() ?? null),
    dispatch: (command) => {
      commands.push(command);
      const failure = dispatchResults.shift();
      return failure ? Effect.fail(failure) : Effect.succeed({ sequence: commands.length });
    },
    listRefs: () => Effect.die("not used"),
    switchRef: () => Effect.die("not used"),
    dispatchBootstrap: () => Effect.die("not used"),
  };
  return { commands, transport };
};

describe("standard ingress", () => {
  it.effect("fails closed when the configured project is stale", () =>
    Effect.gen(function* () {
      const { transport } = makeTransport();
      const exit = yield* Effect.exit(
        startStandardIngress({
          request: {
            ...request,
            target: { ...request.target, projectId: ProjectId.make("missing") },
          },
          publicBaseUrl: "https://t3.example",
          transport,
        }),
      );
      expect(exit._tag).toBe("Failure");
      expect(String(exit)).toContain("configured T3 project no longer exists");
    }),
  );

  it.effect("fails closed when the configured model is unavailable", () =>
    Effect.gen(function* () {
      const { transport } = makeTransport();
      const exit = yield* Effect.exit(
        startStandardIngress({
          request: {
            ...request,
            target: {
              ...request.target,
              modelSelection: { ...modelSelection, model: "missing-model" },
            },
          },
          publicBaseUrl: "https://t3.example",
          transport,
        }),
      );
      expect(exit._tag).toBe("Failure");
      expect(String(exit)).toContain("No valid default model");
    }),
  );

  it.effect("creates a current-checkout thread and starts its deterministic initial turn", () =>
    Effect.gen(function* () {
      const { commands, transport } = makeTransport();
      const result = yield* startStandardIngress({
        request,
        publicBaseUrl: "https://t3.example/base/",
        transport,
      });

      expect(result.recovery).toBe("created");
      expect(commands).toMatchInlineSnapshot(`
      [
        {
          "branch": null,
          "commandId": "t3i:v1:slack:slash:1lskOVclnQb82aTZAuFdEw2U5Sxu9Grq2sYH_SMOqJE:command:create",
          "createdAt": "2026-07-31T10:00:00.000Z",
          "interactionMode": "default",
          "modelSelection": {
            "instanceId": "codex",
            "model": "gpt-5",
          },
          "projectId": "project-main",
          "runtimeMode": "full-access",
          "threadId": "t3i:v1:slack:slash:1lskOVclnQb82aTZAuFdEw2U5Sxu9Grq2sYH_SMOqJE:thread",
          "title": "Investigate a deliberately long build failure prom...",
          "type": "thread.create",
          "worktreePath": null,
        },
        {
          "commandId": "t3i:v1:slack:slash:1lskOVclnQb82aTZAuFdEw2U5Sxu9Grq2sYH_SMOqJE:command:start",
          "createdAt": "2026-07-31T10:00:00.000Z",
          "interactionMode": "default",
          "message": {
            "attachments": [],
            "messageId": "t3i:v1:slack:slash:1lskOVclnQb82aTZAuFdEw2U5Sxu9Grq2sYH_SMOqJE:message:initial",
            "role": "user",
            "text": "Investigate a deliberately long build failure prompt Investigate a deliberately long build failure prompt",
          },
          "modelSelection": {
            "instanceId": "codex",
            "model": "gpt-5",
          },
          "runtimeMode": "full-access",
          "threadId": "t3i:v1:slack:slash:1lskOVclnQb82aTZAuFdEw2U5Sxu9Grq2sYH_SMOqJE:thread",
          "titleSeed": "Investigate a deliberately long build failure prom...",
          "type": "thread.turn.start",
        },
      ]
    `);
    }),
  );

  it.effect("prefers the integration model over the project default", () =>
    Effect.gen(function* () {
      const { commands, transport } = makeTransport();
      yield* startStandardIngress({
        request: {
          ...request,
          target: {
            projectId,
            modelSelection: { ...modelSelection, model: "gpt-5-integration" },
          },
        },
        publicBaseUrl: "https://t3.example",
        transport,
      });
      expect(commands).toHaveLength(2);
      expect(commands[0]).toMatchObject({
        modelSelection: { instanceId: modelSelection.instanceId, model: "gpt-5-integration" },
      });
      expect(commands[1]).toMatchObject({
        modelSelection: { instanceId: modelSelection.instanceId, model: "gpt-5-integration" },
      });
    }),
  );

  it.effect("starts only when the deterministic thread already exists without its message", () =>
    Effect.gen(function* () {
      const expectedThreadId =
        "t3i:v1:slack:slash:1lskOVclnQb82aTZAuFdEw2U5Sxu9Grq2sYH_SMOqJE:thread" as ThreadId;
      const { commands, transport: base } = makeTransport({
        snapshots: [threadSnapshot(expectedThreadId, [])],
      });
      const transport: T3Transport = {
        ...base,
        getShellSnapshot: () => Effect.die("partial recovery must use the persisted target"),
      };
      const result = yield* startStandardIngress({
        request,
        publicBaseUrl: "https://t3.example",
        transport,
      });
      expect(result.recovery).toBe("resumed");
      expect(commands.map((command) => command.type)).toEqual(["thread.turn.start"]);
      expect(commands[0]).toMatchObject({ modelSelection, titleSeed: "Existing thread title" });
    }),
  );

  it.effect("returns the existing link when the deterministic message is present", () =>
    Effect.gen(function* () {
      const expectedThreadId =
        "t3i:v1:slack:slash:1lskOVclnQb82aTZAuFdEw2U5Sxu9Grq2sYH_SMOqJE:thread" as ThreadId;
      const messageId =
        "t3i:v1:slack:slash:1lskOVclnQb82aTZAuFdEw2U5Sxu9Grq2sYH_SMOqJE:message:initial";
      const { commands, transport } = makeTransport({
        snapshots: [threadSnapshot(expectedThreadId, [messageId])],
      });
      const result = yield* startStandardIngress({
        request,
        publicBaseUrl: "https://t3.example",
        transport,
      });
      expect(result.recovery).toBe("already-started");
      expect(commands).toEqual([]);
    }),
  );

  it.effect("returns an existing conversation without resolving stale project defaults", () =>
    Effect.gen(function* () {
      const expectedThreadId =
        "t3i:v1:slack:slash:1lskOVclnQb82aTZAuFdEw2U5Sxu9Grq2sYH_SMOqJE:thread" as ThreadId;
      const messageId =
        "t3i:v1:slack:slash:1lskOVclnQb82aTZAuFdEw2U5Sxu9Grq2sYH_SMOqJE:message:initial";
      const { transport: base } = makeTransport({
        snapshots: [threadSnapshot(expectedThreadId, [messageId])],
      });
      const transport: T3Transport = {
        ...base,
        getShellSnapshot: () => Effect.die("current defaults must not be read"),
      };
      const result = yield* startStandardIngress({
        request: {
          ...request,
          target: { projectId: ProjectId.make("removed-project"), modelSelection: null },
        },
        publicBaseUrl: "https://t3.example",
        transport,
      });
      expect(result.recovery).toBe("already-started");
    }),
  );

  it.effect("reconciles an HTTP internal create failure and resumes start", () =>
    Effect.gen(function* () {
      const expectedThreadId =
        "t3i:v1:slack:slash:1lskOVclnQb82aTZAuFdEw2U5Sxu9Grq2sYH_SMOqJE:thread" as ThreadId;
      const { commands, transport } = makeTransport({
        snapshots: [null, threadSnapshot(expectedThreadId, [])],
        dispatchResults: [new T3TransportError("internal", "ambiguous", null), null],
      });
      const result = yield* startStandardIngress({
        request,
        publicBaseUrl: "https://t3.example",
        transport,
      });
      expect(result.recovery).toBe("resumed");
      expect(commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.start",
      ]);
    }),
  );

  it.effect("returns unverified when ambiguous dispatch cannot be reconciled", () =>
    Effect.gen(function* () {
      const { transport } = makeTransport({
        snapshots: [null, null],
        dispatchResults: [new T3TransportError("timeout", "ambiguous", null)],
      });
      const result = yield* startStandardIngress({
        request,
        publicBaseUrl: "https://t3.example",
        transport,
      });
      expect(result.recovery).toBe("unverified");
    }),
  );

  it.effect("fails when an internal rejection is reconciled as definitively absent", () =>
    Effect.gen(function* () {
      const { transport } = makeTransport({
        snapshots: [null, null],
        dispatchResults: [new T3TransportError("internal", "rejected", null)],
      });
      const exit = yield* Effect.exit(
        startStandardIngress({ request, publicBaseUrl: "https://t3.example", transport }),
      );
      expect(exit._tag).toBe("Failure");
      expect(String(exit)).toContain("rejected");
    }),
  );

  it("encodes environment and thread path segments", () => {
    expect(
      buildThreadDeepLink({
        publicBaseUrl: "https://t3.example/root/?ignored=yes#ignored",
        environmentId: "env/value",
        threadId: "thread/value" as ThreadId,
      }),
    ).toBe("https://t3.example/root/env%2Fvalue/thread%2Fvalue");
  });
});
