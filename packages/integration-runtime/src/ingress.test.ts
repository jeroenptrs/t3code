import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadLaunchInput,
  type ServerConfig,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { deriveIngressIds } from "./identity.ts";
import { buildThreadDeepLink, startStandardIngress } from "./ingress.ts";
import { INGRESS_IDENTITY_VERSION, type IngressRequest } from "./model.ts";
import { launchResult, projectShell, shellSnapshot, threadSnapshot } from "./testFixtures.ts";
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
const ids = deriveIngressIds(request.invocation);

const shell = shellSnapshot(1, [
  projectShell(projectId, {
    title: "T3 Code",
    workspaceRoot: "/workspace/t3code",
    defaultModelSelection: modelSelection,
  }),
]);

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

const existingThread = (messageIds: ReadonlyArray<string>): OrchestrationV2ThreadDetailSnapshot =>
  threadSnapshot({ threadId: ids.threadId, projectId, modelSelection, messageIds });

/**
 * `snapshots` answers successive thread reads; `launches` answers successive
 * launch calls with a transport failure or the server's `resumed` flag.
 */
const makeTransport = (input?: {
  readonly snapshots?: ReadonlyArray<OrchestrationV2ThreadDetailSnapshot | T3TransportError | null>;
  readonly launches?: ReadonlyArray<T3TransportError | { readonly resumed: boolean }>;
}) => {
  const launched: Array<OrchestrationV2ThreadLaunchInput> = [];
  const snapshots = [...(input?.snapshots ?? [null])];
  const launches = [...(input?.launches ?? [])];
  let threadReads = 0;
  const transport: T3Transport = {
    close: () => Effect.void,
    validateSession: () => Effect.die("not used"),
    getShellSnapshot: () => Effect.succeed(shell),
    subscribeShell: () => Stream.never,
    getServerConfig: () => Effect.succeed(config),
    getThreadSnapshot: () =>
      Effect.suspend(() => {
        threadReads += 1;
        const next = snapshots.shift() ?? null;
        return next instanceof T3TransportError ? Effect.fail(next) : Effect.succeed(next);
      }),
    launchThread: (launch) =>
      Effect.suspend(() => {
        launched.push(launch);
        const outcome = launches.shift() ?? { resumed: false };
        return outcome instanceof T3TransportError
          ? Effect.fail(outcome)
          : Effect.succeed(
              launchResult({
                threadId: ids.threadId,
                projectId: launch.projectId,
                modelSelection: launch.modelSelection,
                messageIds: [ids.messageId],
                resumed: outcome.resumed,
              }),
            );
      }),
    listRefs: () => Effect.die("not used"),
    subscribeVcsStatus: () => Stream.never,
    switchRef: () => Effect.die("not used"),
  };
  return { launched, transport, threadReads: () => threadReads };
};

describe("standard ingress", () => {
  it.effect("fails closed when the configured project is stale", () =>
    Effect.gen(function* () {
      const { transport, launched } = makeTransport();
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
      expect(launched).toEqual([]);
    }),
  );

  it.effect("fails closed when the configured model is unavailable", () =>
    Effect.gen(function* () {
      const { transport, launched } = makeTransport();
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
      expect(launched).toEqual([]);
    }),
  );

  it.effect("launches a root-checkout thread with its deterministic initial message", () =>
    Effect.gen(function* () {
      const { launched, transport } = makeTransport();
      const result = yield* startStandardIngress({
        request,
        publicBaseUrl: "https://t3.example/base/",
        transport,
      });

      expect(result).toEqual({
        recovery: "created",
        threadId: ids.threadId,
        deepLink: `https://t3.example/base/environment-main/${encodeURIComponent(ids.threadId)}`,
      });
      expect(launched).toMatchInlineSnapshot(`
        [
          {
            "commandId": "t3i:v1:slack:slash:1lskOVclnQb82aTZAuFdEw2U5Sxu9Grq2sYH_SMOqJE:command:launch",
            "creationSource": "server",
            "generateTitle": true,
            "initialMessage": {
              "attachments": [],
              "messageId": "t3i:v1:slack:slash:1lskOVclnQb82aTZAuFdEw2U5Sxu9Grq2sYH_SMOqJE:message:initial",
              "text": "Investigate a deliberately long build failure prompt Investigate a deliberately long build failure prompt",
            },
            "interactionMode": "default",
            "modelSelection": {
              "instanceId": "codex",
              "model": "gpt-5",
            },
            "projectId": "project-main",
            "runtimeMode": "full-access",
            "threadId": "t3i:v1:slack:slash:1lskOVclnQb82aTZAuFdEw2U5Sxu9Grq2sYH_SMOqJE:thread",
            "title": "Investigate a deliberately long build failure prom...",
            "workspaceStrategy": {
              "type": "root",
            },
          },
        ]
      `);
    }),
  );

  it.effect("inherits the environment model when the project has no override", () =>
    Effect.gen(function* () {
      const { transport, launched } = makeTransport();
      yield* startStandardIngress({
        request,
        publicBaseUrl: "https://t3.example.com",
        transport: {
          ...transport,
          getShellSnapshot: () =>
            Effect.succeed({
              ...shell,
              projects: shell.projects.map((project) => ({
                ...project,
                defaultModelSelection: null,
              })),
            }),
          getServerConfig: () =>
            Effect.succeed({
              ...config,
              settings: { ...config.settings, defaultModelSelection: modelSelection },
            }),
        },
      });
      expect(launched[0]).toMatchObject({ modelSelection });
    }),
  );

  it.effect("prefers the integration model over the project default", () =>
    Effect.gen(function* () {
      const { launched, transport } = makeTransport();
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
      expect(launched).toHaveLength(1);
      expect(launched[0]).toMatchObject({
        modelSelection: { instanceId: modelSelection.instanceId, model: "gpt-5-integration" },
      });
    }),
  );

  it.effect("relaunches a thread that exists without its message and reports the resume", () =>
    Effect.gen(function* () {
      const { launched, transport } = makeTransport({
        snapshots: [existingThread([])],
        launches: [{ resumed: true }],
      });
      const result = yield* startStandardIngress({
        request,
        publicBaseUrl: "https://t3.example",
        transport,
      });
      expect(result.recovery).toBe("resumed");
      expect(launched.map((launch) => launch.commandId)).toEqual([ids.launchCommandId]);
    }),
  );

  it.effect("returns the existing link when the deterministic message is present", () =>
    Effect.gen(function* () {
      const { launched, transport } = makeTransport({
        snapshots: [existingThread([ids.messageId])],
      });
      const result = yield* startStandardIngress({
        request,
        publicBaseUrl: "https://t3.example",
        transport,
      });
      expect(result.recovery).toBe("already-started");
      expect(launched).toEqual([]);
    }),
  );

  it.effect("returns an existing conversation without resolving stale project defaults", () =>
    Effect.gen(function* () {
      const { transport: base } = makeTransport({
        snapshots: [existingThread([ids.messageId])],
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

  it.effect("reports a resume when a failed launch turns out to have landed", () =>
    Effect.gen(function* () {
      const { launched, transport } = makeTransport({
        snapshots: [null, existingThread([ids.messageId])],
        launches: [new T3TransportError("internal", "ambiguous", null)],
      });
      const result = yield* startStandardIngress({
        request,
        publicBaseUrl: "https://t3.example",
        transport,
      });
      expect(result.recovery).toBe("resumed");
      expect(launched).toHaveLength(1);
    }),
  );

  it.effect("returns unverified when a timed-out launch is not visible afterwards", () =>
    Effect.gen(function* () {
      const { transport } = makeTransport({
        snapshots: [null, null],
        launches: [new T3TransportError("timeout", "ambiguous", null)],
      });
      const result = yield* startStandardIngress({
        request,
        publicBaseUrl: "https://t3.example",
        transport,
      });
      expect(result.recovery).toBe("unverified");
    }),
  );

  it.effect("returns unverified when an internal failure cannot be reconciled", () =>
    Effect.gen(function* () {
      const { transport } = makeTransport({
        snapshots: [null, new T3TransportError("unavailable", "offline", null)],
        launches: [new T3TransportError("internal", "ambiguous", null)],
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
        launches: [new T3TransportError("internal", "rejected", null)],
      });
      const exit = yield* Effect.exit(
        startStandardIngress({ request, publicBaseUrl: "https://t3.example", transport }),
      );
      expect(exit._tag).toBe("Failure");
      expect(String(exit)).toContain("rejected");
    }),
  );

  it.effect("propagates a definitive rejection without re-reading the thread", () =>
    Effect.gen(function* () {
      const { transport, threadReads } = makeTransport({
        launches: [new T3TransportError("authorization", "forbidden", null)],
      });
      const error = yield* startStandardIngress({
        request,
        publicBaseUrl: "https://t3.example",
        transport,
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ kind: "authorization" });
      expect(threadReads()).toBe(1);
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
