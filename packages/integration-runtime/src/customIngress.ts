import {
  type ModelSelection,
  type OrchestrationV2ThreadLaunchInput,
  ProjectId,
  type VcsRef,
} from "@t3tools/contracts";
import { canonicalPathIdentity } from "@t3tools/shared/path";
import { truncate } from "@t3tools/shared/String";
import * as Effect from "effect/Effect";

import { deriveIngressIds } from "./identity.ts";
import type { IngressInvocation, IngressResult } from "./model.ts";
import { IngressFailure } from "./model.ts";
import { buildThreadDeepLink, hasIngressMessage, launchIngressThread } from "./ingress.ts";
import {
  decodeBranchSelectionOption,
  encodeBranchSelectionOption,
  findProject,
  modelEffortOptions,
  modelSelectionsEqual,
  resolveModelEffortSelection,
} from "./selectors.ts";
import type { T3Transport } from "./transport.ts";

export interface CustomIngressSelection {
  readonly projectId: string;
  readonly workspace: "current" | "new-worktree";
  readonly branch: string | null;
  readonly modelOption: string;
}

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
    let isRepo = false;
    let selectedRef: VcsRef | null = null;

    const selectedBranch = input.selection.branch
      ? yield* attemptIngressValidation(() => decodeBranchSelectionOption(input.selection.branch!))
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
    } else if (input.selection.workspace === "new-worktree") {
      return yield* Effect.fail(
        new IngressFailure(
          "invalid_request",
          "This project is not a repository and cannot create a worktree.",
        ),
      );
    }

    if (
      snapshot !== null &&
      (snapshot.projection.thread.projectId !== project.id ||
        !modelSelectionsEqual(snapshot.projection.thread.modelSelection, modelSelection))
    ) {
      return yield* Effect.fail(
        new IngressFailure(
          "invalid_request",
          "This partial conversation belongs to a different project or model selection.",
        ),
      );
    }

    let workspaceStrategy: OrchestrationV2ThreadLaunchInput["workspaceStrategy"] = { type: "root" };
    if (input.selection.workspace === "new-worktree") {
      if (!selectedRef) {
        return yield* Effect.fail(new IngressFailure("invalid_request", "Select a base branch."));
      }
      workspaceStrategy = {
        type: "worktree",
        baseRef: selectedRef.name,
        ...(config.settings.newWorktreesStartFromOrigin ? { startFromOrigin: true } : {}),
      };
    } else if (selectedRef) {
      const refPath = selectedRef.worktreePath;
      if (
        refPath &&
        canonicalPathIdentity(refPath) !== canonicalPathIdentity(project.workspaceRoot)
      ) {
        workspaceStrategy = {
          type: "existing_worktree",
          worktreePath: refPath,
          branch: selectedRef.name,
        };
      } else {
        // A root launch records the branch without touching the checkout, so
        // the project checkout is moved to the selected branch first.
        yield* input.transport.switchRef({ cwd: project.workspaceRoot, refName: selectedRef.name });
        workspaceStrategy = { type: "root", branch: selectedRef.name };
      }
    }

    return yield* launchIngressThread({
      ids,
      deepLink,
      transport: input.transport,
      prompt,
      launch: {
        projectId: ProjectId.make(project.id),
        title,
        generateTitle: true,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy,
      },
    });
  },
);
