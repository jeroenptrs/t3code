import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { resolveMergeBackTargetThreadId } from "@t3tools/client-runtime/state/thread-relationships";
import { resolveLatestMergeBackRun } from "@t3tools/client-runtime/state/thread-workflows";
import {
  changeRequestTerminologyFor,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  resolveQuickAction,
  type DefaultBranchConfirmableAction,
  type GitActionRequestInput,
} from "@t3tools/client-runtime/state/vcs";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as ExpoCrypto from "expo-crypto";
import { useEffect, useRef, useState } from "react";

import { tvAtomRegistry } from "../../state/atom-registry";
import { compactMenuBranchLabel, compactMenuStatus } from "./gitMenu";
import { environmentThreadDetails, threadCommands } from "./state";
import { ThreadSheet, type ThreadSheetRow } from "./ThreadSheet";
import { readEnvironmentScope, useEnvironmentScope, vcsActionManager, vcsEnvironment } from "./vcs";

type Notice = { readonly text: string; readonly tone: "muted" | "danger" };
type View =
  | { readonly kind: "menu" }
  | { readonly kind: "review" }
  | {
      readonly kind: "confirm";
      readonly action: DefaultBranchConfirmableAction;
      readonly branchName: string;
    };

const failureMessage = (cause: Cause.Cause<unknown>, fallback: string) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : fallback;
};

/**
 * Mobile's Git header menu (ThreadGitControls.tsx) as a sheet, with its commands wired the way
 * use-selected-thread-git-actions.ts wires them. Results that mobile toasts show as the sheet's
 * notice, and the default-branch confirmation replaces the rows instead of opening a sheet.
 */
export function ThreadGitSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The thread's checkout: its worktree, else the project root. */
  readonly cwd: string;
  /** The project root, where mobile lists branches from. */
  readonly gitRootCwd: string;
  readonly worktreePath: string | null;
  readonly currentBranch: string | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onClose: () => void;
}) {
  const { environmentId, threadId, cwd, worktreePath } = props;
  const target = { environmentId, cwd };
  const statusResult = useAtomValue(vcsEnvironment.status({ environmentId, input: { cwd } }));
  const gitStatus = Option.getOrNull(AsyncResult.value(statusResult));
  const actionState = useAtomValue(vcsActionManager.stateAtom(target));
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const [view, setView] = useState<View>({ kind: "menu" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const mergeBackBusy = useRef(false);
  // The full projection changes with every streamed delta, so only the open sheet reads it.
  const projection =
    useAtomValue(environmentThreadDetails.threadAtom({ environmentId, threadId }))?.projection ??
    null;
  const mergeBackTargetThreadId = resolveMergeBackTargetThreadId(projection);
  const mergeBackRun = projection === null ? null : resolveLatestMergeBackRun(projection);
  const mergeBackTarget =
    mergeBackTargetThreadId !== null && mergeBackRun !== null
      ? { targetThreadId: mergeBackTargetThreadId, runId: mergeBackRun.id }
      : null;

  const refresh = async (options?: { readonly quiet?: boolean }) => {
    const execute = () =>
      runAtomCommand(
        tvAtomRegistry,
        vcsEnvironment.refreshStatus,
        { environmentId, input: { cwd } },
        { reportFailure: false },
      );
    const result = options?.quiet
      ? await execute()
      : await vcsActionManager.track(
          tvAtomRegistry,
          target,
          { operation: "refresh_status", label: "Refreshing source control status" },
          execute,
        );
    if (AsyncResult.isFailure(result)) {
      setNotice({
        text: failureMessage(result.cause, "Failed to refresh git status."),
        tone: "danger",
      });
    }
  };

  // Opening the menu refreshes the checkout once, as selecting a thread does on mobile. A failure
  // leaves the subscribed status as it was; Refresh reports errors.
  useEffect(() => {
    void runAtomCommand(
      tvAtomRegistry,
      vcsEnvironment.refreshStatus,
      { environmentId, input: { cwd } },
      { reportFailure: false },
    );
  }, [cwd, environmentId]);

  const canMutate = (changesThreadBranch: boolean) =>
    readEnvironmentScope(environmentId, AuthSourceControlWriteScope) &&
    (!changesThreadBranch || readEnvironmentScope(environmentId, AuthOrchestrationOperateScope));

  const setThreadBranch = async (branch: string | null) => {
    const result = await runAtomCommand(
      tvAtomRegistry,
      threadCommands.updateMetadata,
      { environmentId, input: { threadId, branch, worktreePath } },
      { reportFailure: false },
    );
    await refresh({ quiet: true });
    return result;
  };

  const pull = async () => {
    if (!canMutate(false)) return;
    setNotice(null);
    const result = await vcsActionManager.track(
      tvAtomRegistry,
      target,
      { operation: "pull", label: "Pulling latest changes" },
      async () => {
        const pulled = await runAtomCommand(
          tvAtomRegistry,
          vcsEnvironment.pull,
          { environmentId, input: { cwd } },
          { reportFailure: false },
        );
        if (AsyncResult.isSuccess(pulled)) await refresh({ quiet: true });
        return pulled;
      },
    );
    setNotice(
      AsyncResult.isFailure(result)
        ? { text: failureMessage(result.cause, "Git action failed."), tone: "danger" }
        : {
            text:
              result.value.status === "skipped_up_to_date"
                ? "Already up to date"
                : `Pulled latest on ${result.value.refName}`,
            tone: "muted",
          },
    );
  };

  const runAction = async (input: GitActionRequestInput) => {
    if (!canMutate(input.featureBranch === true)) return;
    setNotice(null);
    const result = await runAtomCommand(
      tvAtomRegistry,
      vcsActionManager.runStackedAction(target),
      {
        actionId: ExpoCrypto.randomUUID(),
        action: input.action,
        ...(input.featureBranch ? { featureBranch: true } : {}),
        threadId,
      },
      { reportFailure: false },
    );
    if (AsyncResult.isFailure(result)) {
      setNotice({ text: failureMessage(result.cause, "Git action failed."), tone: "danger" });
      return;
    }
    const { branch, toast } = result.value;
    if (branch.status === "created" && branch.name) await setThreadBranch(branch.name);
    else await refresh({ quiet: true });
    // The TV cannot open a browser, so a created pull request's link is shown to open elsewhere.
    const prUrl = toast.cta.kind === "open_pr" ? toast.cta.url : null;
    setNotice({
      text: [toast.title, toast.description, prUrl].filter(Boolean).join("\n"),
      tone: "muted",
    });
  };

  /** Mobile's "Feature branch & continue" (GitConfirmSheet.tsx). */
  const runOnFeatureBranch = async (action: DefaultBranchConfirmableAction) => {
    if (action === "commit_push" || action === "commit_push_pr") {
      await runAction({ action, featureBranch: true });
      return;
    }
    if (!canMutate(true)) return;
    setNotice(null);
    const refs = await runAtomCommand(
      tvAtomRegistry,
      vcsEnvironment.readRefs,
      { environmentId, input: { cwd: props.gitRootCwd, refKind: "local", limit: 200 } },
      { reportFailure: false },
    );
    if (AsyncResult.isFailure(refs)) {
      setNotice({ text: failureMessage(refs.cause, "Git action failed."), tone: "danger" });
      return;
    }
    const refName = resolveAutoFeatureBranchName(
      refs.value.refs.filter((ref) => !ref.isRemote).map((ref) => ref.name),
    );
    const created = await vcsActionManager.track(
      tvAtomRegistry,
      target,
      { operation: "create_ref", label: "Creating branch" },
      () =>
        runAtomCommand(
          tvAtomRegistry,
          vcsEnvironment.createRef,
          { environmentId, input: { cwd, refName, switchRef: true } },
          { reportFailure: false },
        ),
    );
    if (AsyncResult.isFailure(created)) {
      setNotice({ text: failureMessage(created.cause, "Git action failed."), tone: "danger" });
      return;
    }
    await setThreadBranch(created.value.refName);
    await runAction({ action });
  };

  const terminology = changeRequestTerminologyFor(gitStatus);
  const busy = actionState.isRunning;
  const isRepo = gitStatus?.isRepo ?? true;
  const isDefaultRef = gitStatus?.isDefaultRef ?? false;
  const quickAction = (() => {
    if (!isRepo) {
      return {
        label: "Git unavailable",
        disabled: true,
        kind: "show_hint" as const,
        hint: "This workspace is not a git repository.",
      };
    }
    const action = resolveQuickAction(
      gitStatus,
      busy,
      isDefaultRef,
      gitStatus?.hasPrimaryRemote ?? false,
    );
    return !canWriteSourceControl && (action.kind === "run_pull" || action.kind === "run_action")
      ? { ...action, disabled: true, hint: "This connection cannot change source control." }
      : action;
  })();

  const runQuickAction = () => {
    if (quickAction.disabled) return;
    if (quickAction.kind === "open_pr") {
      const pr = gitStatus?.pr?.state === "open" ? gitStatus.pr : null;
      setNotice(
        pr
          ? { text: `${pr.title}\n${pr.url}`, tone: "muted" }
          : {
              text: `This branch does not have an open ${terminology.singular}.`,
              tone: "danger",
            },
      );
      return;
    }
    if (quickAction.kind === "run_pull") {
      void pull();
      return;
    }
    const action = quickAction.kind === "run_action" ? quickAction.action : undefined;
    if (action === undefined) return;
    const branchName = gitStatus?.refName;
    if (
      branchName &&
      requiresDefaultBranchConfirmation(action, isDefaultRef) &&
      (action === "push" ||
        action === "create_pr" ||
        action === "commit_push" ||
        action === "commit_push_pr")
    ) {
      setView({ kind: "confirm", action, branchName });
      return;
    }
    void runAction({ action });
  };

  const mergeBack = async () => {
    if (mergeBackTarget === null || mergeBackBusy.current) return;
    mergeBackBusy.current = true;
    const result = await runAtomCommand(
      tvAtomRegistry,
      threadCommands.mergeBack,
      {
        environmentId,
        input: {
          sourceThreadId: threadId,
          targetThreadId: mergeBackTarget.targetThreadId,
          runId: mergeBackTarget.runId,
          creationSource: "mobile",
        },
      },
      { reportFailure: false },
    );
    mergeBackBusy.current = false;
    if (AsyncResult.isFailure(result)) {
      setNotice({ text: failureMessage(result.cause, "Merge back failed."), tone: "danger" });
      return;
    }
    props.onClose();
    props.onOpenThread(mergeBackTarget.targetThreadId);
  };

  const close = () => {
    if (view.kind === "menu") props.onClose();
    else setView({ kind: "menu" });
  };
  const operationNotice: Notice | null =
    busy && actionState.currentLabel
      ? { text: `${actionState.currentLabel}…`, tone: "muted" }
      : actionState.error
        ? { text: actionState.error, tone: "danger" }
        : null;

  if (view.kind === "review") {
    const files = gitStatus?.workingTree.files ?? [];
    return (
      <ThreadSheet
        title="Review changes"
        subtitle={
          gitStatus === null
            ? "Checking status"
            : files.length === 0
              ? "No uncommitted changes"
              : `${files.length} changed  ·  +${gitStatus.workingTree.insertions} −${gitStatus.workingTree.deletions}`
        }
        rows={files.map((file) => ({
          key: file.path,
          label: file.path,
          subtitle: `+${file.insertions} −${file.deletions}`,
        }))}
        onClose={close}
      />
    );
  }

  if (view.kind === "confirm") {
    const includesCommit = view.action === "commit_push" || view.action === "commit_push_pr";
    const copy = resolveDefaultBranchActionDialogCopy({
      action: view.action,
      branchName: view.branchName,
      includesCommit,
      terminology,
    });
    const { action } = view;
    return (
      <ThreadSheet
        title={copy.title}
        subtitle={copy.description}
        rows={[
          {
            key: "continue",
            label: copy.continueLabel,
            onPress: () => {
              setView({ kind: "menu" });
              void runAction({ action });
            },
          },
          {
            key: "feature-branch",
            label: "Feature branch & continue",
            onPress: () => {
              setView({ kind: "menu" });
              void runOnFeatureBranch(action);
            },
          },
          { key: "cancel", label: "Cancel", onPress: () => setView({ kind: "menu" }) },
        ]}
        onClose={close}
      />
    );
  }

  const rows: Array<ThreadSheetRow> = [
    {
      key: "branch",
      label: compactMenuBranchLabel(gitStatus?.refName ?? props.currentBranch ?? "Detached HEAD"),
      subtitle: compactMenuStatus(gitStatus),
      disabled: true,
    },
    {
      key: "quick-action",
      label: quickAction.label,
      subtitle: quickAction.disabled ? (quickAction.hint ?? "This action is unavailable.") : null,
      disabled: quickAction.disabled,
      tone: "accent",
      onPress: runQuickAction,
    },
    {
      key: "review",
      label: "Review changes",
      subtitle: "Changed files in this checkout",
      disabled: !isRepo,
      onPress: () => setView({ kind: "review" }),
    },
    ...(mergeBackTarget
      ? [
          {
            key: "merge-back",
            label: "Merge back to source",
            subtitle: "Bring this thread's latest turn into its source",
            onPress: () => void mergeBack(),
          },
        ]
      : []),
    {
      key: "refresh",
      label: "Refresh",
      subtitle: "Check the branch and its remote again",
      disabled: busy,
      onPress: () => void refresh(),
    },
  ];

  return <ThreadSheet title="Git" notice={notice ?? operationNotice} rows={rows} onClose={close} />;
}
