import type {
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadLaunchInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { deriveIngressIds } from "./identity.ts";
import {
  type IngressIds,
  type IngressRequest,
  type IngressResult,
  type IngressRecovery,
} from "./model.ts";
import { resolveStandardIngressTarget } from "./resolution.ts";
import { T3TransportError, type T3Transport } from "./transport.ts";

const shouldReconcileLaunchError = (error: T3TransportError): boolean =>
  error.kind === "internal" || error.kind === "timeout" || error.kind === "unavailable";

export const hasIngressMessage = (
  snapshot: OrchestrationV2ThreadDetailSnapshot | null,
  ids: IngressIds,
): boolean =>
  snapshot?.projection.messages.some((message) => message.id === ids.messageId) ?? false;

export const buildEnvironmentDeepLink = (input: {
  readonly publicBaseUrl: string;
  readonly environmentId: string;
}): string => {
  const url = new URL(input.publicBaseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(input.environmentId)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};

export const buildThreadDeepLink = (input: {
  readonly publicBaseUrl: string;
  readonly environmentId: string;
  readonly threadId: ThreadId;
}): string => {
  const url = new URL(
    buildEnvironmentDeepLink({
      publicBaseUrl: input.publicBaseUrl,
      environmentId: input.environmentId,
    }),
  );
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(input.threadId)}`;
  return url.toString();
};

/**
 * Launches the ingress thread. Launch is idempotent by command id, so a retry
 * of the same invocation resumes instead of duplicating. After an ambiguous
 * failure the thread is re-read to tell a landed launch from a lost one.
 */
export const launchIngressThread = Effect.fn("integrationRuntime.launchIngressThread")(
  function* (input: {
    readonly ids: IngressIds;
    readonly deepLink: string;
    readonly transport: T3Transport;
    readonly launch: Omit<
      OrchestrationV2ThreadLaunchInput,
      "commandId" | "threadId" | "creationSource" | "initialMessage"
    >;
    readonly prompt: string;
  }) {
    const { ids, deepLink } = input;
    const launched = yield* input.transport
      .launchThread({
        ...input.launch,
        commandId: ids.launchCommandId,
        threadId: ids.threadId,
        creationSource: "server",
        initialMessage: { messageId: ids.messageId, text: input.prompt, attachments: [] },
      })
      .pipe(Effect.result);
    if (launched._tag === "Success") {
      const recovery: IngressRecovery = launched.success.resumed ? "resumed" : "created";
      return { recovery, threadId: ids.threadId, deepLink } satisfies IngressResult;
    }
    if (!shouldReconcileLaunchError(launched.failure)) return yield* Effect.fail(launched.failure);
    const reconciled = yield* input.transport.getThreadSnapshot(ids.threadId).pipe(Effect.result);
    if (reconciled._tag === "Success" && hasIngressMessage(reconciled.success, ids)) {
      return { recovery: "resumed", threadId: ids.threadId, deepLink } satisfies IngressResult;
    }
    if (reconciled._tag === "Success" && launched.failure.kind === "internal") {
      return yield* Effect.fail(launched.failure);
    }
    return { recovery: "unverified", threadId: ids.threadId, deepLink } satisfies IngressResult;
  },
);

export const startStandardIngress = Effect.fn("integrationRuntime.startStandardIngress")(
  function* (input: {
    readonly request: IngressRequest;
    readonly publicBaseUrl: string;
    readonly transport: T3Transport;
  }) {
    const ids = deriveIngressIds(input.request.invocation);
    const snapshot = yield* input.transport.getThreadSnapshot(ids.threadId);
    const config = yield* input.transport.getServerConfig();
    const deepLink = buildThreadDeepLink({
      publicBaseUrl: input.publicBaseUrl,
      environmentId: config.environment.environmentId,
      threadId: ids.threadId,
    });
    if (hasIngressMessage(snapshot, ids)) {
      return {
        recovery: "already-started",
        threadId: ids.threadId,
        deepLink,
      } satisfies IngressResult;
    }

    const shell = yield* input.transport.getShellSnapshot();
    const resolved = yield* resolveStandardIngressTarget({
      request: input.request,
      shell,
      config,
    });
    return yield* launchIngressThread({
      ids,
      deepLink,
      transport: input.transport,
      prompt: input.request.invocation.prompt.trim(),
      launch: {
        projectId: resolved.project.id,
        title: resolved.title,
        generateTitle: true,
        modelSelection: resolved.modelSelection,
        runtimeMode: resolved.runtimeMode,
        interactionMode: resolved.interactionMode,
        workspaceStrategy: { type: "root" },
      },
    });
  },
);
