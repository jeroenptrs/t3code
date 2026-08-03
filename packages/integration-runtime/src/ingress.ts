import type {
  ClientOrchestrationCommand,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { deriveIngressIds } from "./identity.ts";
import { type IngressRequest, type IngressResult, type IngressRecovery } from "./model.ts";
import { resolveStandardIngressTarget } from "./resolution.ts";
import { T3TransportError, type T3Transport } from "./transport.ts";

const shouldReconcileDispatchError = (error: T3TransportError): boolean =>
  error.kind === "internal" || error.kind === "timeout" || error.kind === "unavailable";

interface DispatchTarget {
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly title: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

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

export const startStandardIngress = Effect.fn("integrationRuntime.startStandardIngress")(
  function* (input: {
    readonly request: IngressRequest;
    readonly publicBaseUrl: string;
    readonly transport: T3Transport;
  }) {
    const ids = deriveIngressIds(input.request.invocation);
    let snapshot = yield* input.transport.getThreadSnapshot(ids.threadId);
    const config = yield* input.transport.getServerConfig();
    const deepLink = buildThreadDeepLink({
      publicBaseUrl: input.publicBaseUrl,
      environmentId: config.environment.environmentId,
      threadId: ids.threadId,
    });
    if (snapshot?.thread.messages.some((message) => message.id === ids.messageId)) {
      return {
        recovery: "already-started",
        threadId: ids.threadId,
        deepLink,
      } satisfies IngressResult;
    }

    let recovery: IngressRecovery = snapshot === null ? "created" : "resumed";
    let target: DispatchTarget;
    if (snapshot === null) {
      const shell = yield* input.transport.getShellSnapshot();
      const resolved = yield* resolveStandardIngressTarget({
        request: input.request,
        shell,
        config,
      });
      target = {
        projectId: resolved.project.id,
        modelSelection: resolved.modelSelection,
        title: resolved.title,
        runtimeMode: resolved.runtimeMode,
        interactionMode: resolved.interactionMode,
      };
      const createCommand: ClientOrchestrationCommand = {
        type: "thread.create",
        commandId: ids.createCommandId,
        threadId: ids.threadId,
        projectId: target.projectId,
        title: target.title,
        modelSelection: target.modelSelection,
        runtimeMode: target.runtimeMode,
        interactionMode: target.interactionMode,
        branch: null,
        worktreePath: null,
        createdAt: input.request.requestedAt,
      };
      const createResult = yield* input.transport.dispatch(createCommand).pipe(Effect.result);
      if (createResult._tag === "Failure") {
        if (!shouldReconcileDispatchError(createResult.failure)) {
          return yield* Effect.fail(createResult.failure);
        }
        const reconciled = yield* input.transport
          .getThreadSnapshot(ids.threadId)
          .pipe(Effect.result);
        if (reconciled._tag === "Failure") {
          return {
            recovery: "unverified",
            threadId: ids.threadId,
            deepLink,
          } satisfies IngressResult;
        }
        if (reconciled.success === null) {
          return createResult.failure.kind === "internal"
            ? yield* Effect.fail(createResult.failure)
            : ({
                recovery: "unverified",
                threadId: ids.threadId,
                deepLink,
              } satisfies IngressResult);
        }
        snapshot = reconciled.success;
        recovery = "resumed";
        target = {
          projectId: snapshot.thread.projectId,
          modelSelection: snapshot.thread.modelSelection,
          title: snapshot.thread.title,
          runtimeMode: snapshot.thread.runtimeMode,
          interactionMode: snapshot.thread.interactionMode,
        };
      }
    } else {
      target = {
        projectId: snapshot.thread.projectId,
        modelSelection: snapshot.thread.modelSelection,
        title: snapshot.thread.title,
        runtimeMode: snapshot.thread.runtimeMode,
        interactionMode: snapshot.thread.interactionMode,
      };
    }

    if (snapshot?.thread.messages.some((message) => message.id === ids.messageId)) {
      return { recovery, threadId: ids.threadId, deepLink } satisfies IngressResult;
    }

    const startCommand: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: ids.startCommandId,
      threadId: ids.threadId,
      message: {
        messageId: ids.messageId,
        role: "user",
        text: input.request.invocation.prompt.trim(),
        attachments: [],
      },
      modelSelection: target.modelSelection,
      titleSeed: target.title,
      runtimeMode: target.runtimeMode,
      interactionMode: target.interactionMode,
      createdAt: input.request.requestedAt,
    };
    const startResult = yield* input.transport.dispatch(startCommand).pipe(Effect.result);
    if (startResult._tag === "Success") {
      return { recovery, threadId: ids.threadId, deepLink } satisfies IngressResult;
    }
    if (!shouldReconcileDispatchError(startResult.failure)) {
      return yield* Effect.fail(startResult.failure);
    }
    const reconciled = yield* input.transport.getThreadSnapshot(ids.threadId).pipe(Effect.result);
    if (
      reconciled._tag === "Success" &&
      reconciled.success?.thread.messages.some((message) => message.id === ids.messageId)
    ) {
      return { recovery, threadId: ids.threadId, deepLink } satisfies IngressResult;
    }
    if (reconciled._tag === "Success" && startResult.failure.kind === "internal") {
      return yield* Effect.fail(startResult.failure);
    }
    return { recovery: "unverified", threadId: ids.threadId, deepLink } satisfies IngressResult;
  },
);
