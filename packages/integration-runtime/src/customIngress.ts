import {
  type ClientOrchestrationCommand,
  type ModelSelection,
  ProjectId,
  type VcsRef,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { canonicalPathIdentity } from "@t3tools/shared/path";
import { truncate } from "@t3tools/shared/String";
import * as Effect from "effect/Effect";

import { deriveIngressIds } from "./identity.ts";
import type { IngressInvocation, IngressResult, IngressRecovery } from "./model.ts";
import { IngressFailure } from "./model.ts";
import { buildThreadDeepLink } from "./ingress.ts";
import {
  decodeBranchSelectionOption,
  encodeBranchSelectionOption,
  findProject,
  modelEffortOptions,
  modelSelectionsEqual,
  resolveModelEffortSelection,
} from "./selectors.ts";
import { T3TransportError, type T3Transport } from "./transport.ts";

export interface CustomIngressSelection {
  readonly projectId: string;
  readonly workspace: "current" | "new-worktree";
  readonly branch: string | null;
  readonly modelOption: string;
}

const shouldReconcile = (error: T3TransportError) =>
  error.kind === "internal" || error.kind === "timeout" || error.kind === "unavailable";

const deterministicBranchToken = (value: string): string => {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const exactRef = (refs: ReadonlyArray<VcsRef>, selection: string): VcsRef | null =>
  refs.find((ref) => encodeBranchSelectionOption(ref) === selection) ?? null;

const attemptIngressValidation = <A>(evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: (cause) =>
      cause instanceof IngressFailure
        ? cause
        : new IngressFailure("invalid_request", "The custom setup selection is invalid."),
  });

export const startCustomIngress = Effect.fn("integrationRuntime.startCustomIngress")(
  function* (input: {
    readonly invocation: IngressInvocation;
    readonly selection: CustomIngressSelection;
    readonly integrationDefault: ModelSelection | null;
    readonly requestedAt: string;
    readonly publicBaseUrl: string;
    readonly transport: T3Transport;
  }) {
    const prompt = input.invocation.prompt.trim();
    if (!prompt)
      return yield* Effect.fail(new IngressFailure("invalid_request", "A prompt is required."));
    const ids = deriveIngressIds(input.invocation);
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
    const shell = yield* input.transport.getShellSnapshot();
    const project = yield* attemptIngressValidation(() =>
      findProject(shell, input.selection.projectId),
    );
    const modelSelection = yield* attemptIngressValidation(() =>
      resolveModelEffortSelection(
        modelEffortOptions({
          config,
          project,
          integrationDefault: input.integrationDefault,
        }),
        input.selection.modelOption,
      ),
    );
    const title = truncate(prompt);
    let branch: string | null = null;
    let worktreePath: string | null = null;
    let isRepo = false;
    let selectedRef: VcsRef | null = null;

    const selectedBranch = input.selection.branch
      ? yield* attemptIngressValidation(() => decodeBranchSelectionOption(input.selection.branch!))
      : null;
    const temporaryBranch = selectedBranch
      ? buildTemporaryWorktreeBranchName(() =>
          deterministicBranchToken(`${ids.threadId}\u0000${selectedBranch}`),
        )
      : null;
    let cursor: number | undefined;
    let nextCursor: number | null = null;
    do {
      const page = yield* input.transport.listRefs({
        cwd: project.workspaceRoot,
        ...(cursor === undefined ? {} : { cursor }),
        includeMatchingRemoteRefs: true,
        limit: 200,
      });
      isRepo = page.isRepo;
      selectedRef ??= selectedBranch ? exactRef(page.refs, selectedBranch) : null;
      nextCursor = selectedRef ? null : page.nextCursor;
      cursor = nextCursor ?? undefined;
    } while (nextCursor !== null);
    if (isRepo) {
      if (!input.selection.branch) {
        return yield* Effect.fail(new IngressFailure("invalid_request", "Select a branch."));
      }
      if (!selectedRef) {
        return yield* Effect.fail(
          new IngressFailure(
            "invalid_request",
            "The selected branch or worktree is no longer available.",
          ),
        );
      }
      branch = selectedRef.name;
    } else if (input.selection.workspace === "new-worktree") {
      return yield* Effect.fail(
        new IngressFailure(
          "invalid_request",
          "This project is not a repository and cannot create a worktree.",
        ),
      );
    }

    if (snapshot !== null) {
      const identityChanged =
        snapshot.thread.projectId !== project.id ||
        !modelSelectionsEqual(snapshot.thread.modelSelection, modelSelection);
      if (identityChanged) {
        return yield* Effect.fail(
          new IngressFailure(
            "invalid_request",
            "This partial conversation belongs to a different project or model selection.",
          ),
        );
      }
      if (input.selection.workspace === "new-worktree") {
        if (!temporaryBranch || snapshot.thread.branch !== temporaryBranch) {
          return yield* Effect.fail(
            new IngressFailure(
              "invalid_request",
              "This partial conversation belongs to a different workspace or base branch.",
            ),
          );
        }
        return {
          recovery: "unverified",
          threadId: ids.threadId,
          deepLink,
        } satisfies IngressResult;
      }
      const selectedWorktreePath = selectedRef?.worktreePath ?? null;
      const selectedIsRoot =
        selectedWorktreePath === null ||
        canonicalPathIdentity(selectedWorktreePath) ===
          canonicalPathIdentity(project.workspaceRoot);
      const storedMappingMatches = snapshot.thread.worktreePath
        ? selectedWorktreePath === snapshot.thread.worktreePath
        : selectedIsRoot;
      if (snapshot.thread.branch !== branch || !storedMappingMatches) {
        return yield* Effect.fail(
          new IngressFailure(
            "invalid_request",
            "This partial conversation belongs to a different branch or workspace mapping.",
          ),
        );
      }
      const start: ClientOrchestrationCommand = {
        type: "thread.turn.start",
        commandId: ids.startCommandId,
        threadId: ids.threadId,
        message: { messageId: ids.messageId, role: "user", text: prompt, attachments: [] },
        modelSelection: snapshot.thread.modelSelection,
        titleSeed: snapshot.thread.title,
        runtimeMode: snapshot.thread.runtimeMode,
        interactionMode: snapshot.thread.interactionMode,
        createdAt: input.requestedAt,
      };
      const resumesRootCheckout =
        isRepo &&
        selectedRef !== null &&
        (!selectedRef.worktreePath ||
          canonicalPathIdentity(selectedRef.worktreePath) ===
            canonicalPathIdentity(project.workspaceRoot));
      const rootRefName = selectedRef?.name;
      const startResult = yield* (
        resumesRootCheckout && rootRefName
          ? input.transport.dispatchBootstrap({
              ...start,
              bootstrap: {
                switchRef: { cwd: project.workspaceRoot, refName: rootRefName },
              },
            })
          : input.transport.dispatch(start)
      ).pipe(Effect.result);
      if (startResult._tag === "Failure") {
        if (!shouldReconcile(startResult.failure)) return yield* Effect.fail(startResult.failure);
        const reconciled = yield* input.transport
          .getThreadSnapshot(ids.threadId)
          .pipe(Effect.result);
        if (
          reconciled._tag === "Success" &&
          reconciled.success?.thread.messages.some((message) => message.id === ids.messageId)
        ) {
          return { recovery: "resumed", threadId: ids.threadId, deepLink } satisfies IngressResult;
        }
        if (reconciled._tag === "Success" && startResult.failure.kind === "internal") {
          return yield* Effect.fail(startResult.failure);
        }
        return { recovery: "unverified", threadId: ids.threadId, deepLink } satisfies IngressResult;
      }
      return { recovery: "resumed", threadId: ids.threadId, deepLink } satisfies IngressResult;
    }

    if (input.selection.workspace === "new-worktree") {
      if (!temporaryBranch) {
        return yield* Effect.fail(new IngressFailure("invalid_request", "Select a base branch."));
      }
      const command: ClientOrchestrationCommand = {
        type: "thread.turn.start",
        commandId: ids.startCommandId,
        threadId: ids.threadId,
        message: { messageId: ids.messageId, role: "user", text: prompt, attachments: [] },
        modelSelection,
        titleSeed: title,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: input.requestedAt,
        bootstrap: {
          createThread: {
            projectId: ProjectId.make(project.id),
            title,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: temporaryBranch,
            worktreePath: null,
            createdAt: input.requestedAt,
          },
          prepareWorktree: {
            projectCwd: project.workspaceRoot,
            baseBranch: branch!,
            branch: temporaryBranch,
            ...(config.settings.newWorktreesStartFromOrigin ? { startFromOrigin: true } : {}),
          },
          runSetupScript: true,
        },
      };
      const result = yield* input.transport.dispatchBootstrap(command).pipe(Effect.result);
      if (result._tag === "Success") {
        return { recovery: "created", threadId: ids.threadId, deepLink } satisfies IngressResult;
      }
      if (!shouldReconcile(result.failure)) return yield* Effect.fail(result.failure);
      const reconciled = yield* input.transport.getThreadSnapshot(ids.threadId).pipe(Effect.result);
      if (
        reconciled._tag === "Success" &&
        reconciled.success?.thread.messages.some((message) => message.id === ids.messageId)
      ) {
        return { recovery: "created", threadId: ids.threadId, deepLink } satisfies IngressResult;
      }
      if (reconciled._tag === "Success" && result.failure.kind === "internal") {
        return yield* Effect.fail(result.failure);
      }
      return { recovery: "unverified", threadId: ids.threadId, deepLink } satisfies IngressResult;
    }

    if (isRepo && selectedRef) {
      const refPath = selectedRef.worktreePath;
      if (
        refPath &&
        canonicalPathIdentity(refPath) !== canonicalPathIdentity(project.workspaceRoot)
      ) {
        worktreePath = refPath;
      } else {
        const command: ClientOrchestrationCommand = {
          type: "thread.turn.start",
          commandId: ids.startCommandId,
          threadId: ids.threadId,
          message: { messageId: ids.messageId, role: "user", text: prompt, attachments: [] },
          modelSelection,
          titleSeed: title,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: input.requestedAt,
          bootstrap: {
            switchRef: { cwd: project.workspaceRoot, refName: selectedRef.name },
            createThread: {
              projectId: ProjectId.make(project.id),
              title,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: selectedRef.name,
              worktreePath: null,
              createdAt: input.requestedAt,
            },
          },
        };
        const result = yield* input.transport.dispatchBootstrap(command).pipe(Effect.result);
        if (result._tag === "Success") {
          return { recovery: "created", threadId: ids.threadId, deepLink } satisfies IngressResult;
        }
        if (!shouldReconcile(result.failure)) return yield* Effect.fail(result.failure);
        const reconciled = yield* input.transport
          .getThreadSnapshot(ids.threadId)
          .pipe(Effect.result);
        if (
          reconciled._tag === "Success" &&
          reconciled.success?.thread.messages.some((message) => message.id === ids.messageId)
        ) {
          return { recovery: "created", threadId: ids.threadId, deepLink } satisfies IngressResult;
        }
        if (reconciled._tag === "Success" && result.failure.kind === "internal") {
          return yield* Effect.fail(result.failure);
        }
        return { recovery: "unverified", threadId: ids.threadId, deepLink } satisfies IngressResult;
      }
    }

    const create: ClientOrchestrationCommand = {
      type: "thread.create",
      commandId: ids.createCommandId,
      threadId: ids.threadId,
      projectId: project.id,
      title,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch,
      worktreePath,
      createdAt: input.requestedAt,
    };
    const start: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: ids.startCommandId,
      threadId: ids.threadId,
      message: { messageId: ids.messageId, role: "user", text: prompt, attachments: [] },
      modelSelection,
      titleSeed: title,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: input.requestedAt,
    };
    let recovery: IngressRecovery = "created";
    const createResult = yield* input.transport.dispatch(create).pipe(Effect.result);
    if (createResult._tag === "Failure") {
      if (!shouldReconcile(createResult.failure)) return yield* Effect.fail(createResult.failure);
      const reconciled = yield* input.transport.getThreadSnapshot(ids.threadId).pipe(Effect.result);
      if (reconciled._tag === "Failure") {
        return { recovery: "unverified", threadId: ids.threadId, deepLink } satisfies IngressResult;
      }
      if (reconciled.success === null) {
        return createResult.failure.kind === "internal"
          ? yield* Effect.fail(createResult.failure)
          : ({ recovery: "unverified", threadId: ids.threadId, deepLink } satisfies IngressResult);
      }
      recovery = "resumed";
      snapshot = reconciled.success;
    }
    if (!snapshot?.thread.messages.some((message) => message.id === ids.messageId)) {
      const startResult = yield* input.transport.dispatch(start).pipe(Effect.result);
      if (startResult._tag === "Failure") {
        if (!shouldReconcile(startResult.failure)) return yield* Effect.fail(startResult.failure);
        const reconciled = yield* input.transport
          .getThreadSnapshot(ids.threadId)
          .pipe(Effect.result);
        const messagePersisted =
          reconciled._tag === "Success" &&
          reconciled.success?.thread.messages.some((message) => message.id === ids.messageId);
        if (!messagePersisted) {
          if (reconciled._tag === "Success" && startResult.failure.kind === "internal") {
            return yield* Effect.fail(startResult.failure);
          }
          return {
            recovery: "unverified",
            threadId: ids.threadId,
            deepLink,
          } satisfies IngressResult;
        }
      }
    }
    return { recovery, threadId: ids.threadId, deepLink } satisfies IngressResult;
  },
);
