import { useAtomValue } from "@effect/atom-react";
import {
  deriveThreadActivityRun,
  deriveThreadStructureRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import { resolveSubagentPillSegment } from "@t3tools/client-runtime/state/thread-subagents";
import { DEFAULT_SERVER_SETTINGS, type ServerProvider } from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  StyleSheet,
  Text,
  TVFocusGuideView,
  useTVEventHandler,
  View,
  type ViewInstance,
} from "react-native";

import { FocusablePressable } from "../components/FocusablePressable";
import { colors, typography } from "../components/theme";
import { SUBAGENT_TONE_COLORS } from "../features/subagents/subagentPresentation";
import { SubagentsSheet } from "../features/subagents/SubagentsSheet";
import {
  useDevOpenSheet,
  useDevSendMessage,
  type ThreadSheetKind,
} from "../features/threads/devOpenThread";
import {
  resolveThreadDispatchMode,
  sendThreadMessage,
  threadIsCompacting,
} from "../features/threads/sendThreadMessage";
import { environmentThreadDetails } from "../features/threads/state";
import {
  ThreadMessageList,
  type ThreadMessageListHandle,
} from "../features/threads/ThreadMessageList";
import type { ProjectRef } from "../features/threads/NewThreadComposer";
import { ThreadActionsSheet } from "../features/threads/ThreadActionsSheet";
import { ThreadGitSheet } from "../features/threads/ThreadGitSheet";
import { ThreadReplyBox } from "../features/threads/ThreadReplyBox";
import { ThreadTerminalSheet } from "../features/threads/ThreadTerminalSheet";
import { deriveThreadRows } from "../features/threads/threadRows";
import type { ThreadRef } from "../navigation/stack";
import {
  environmentProjects,
  environmentSummaries,
  environmentThreadShells,
  serverEnvironment,
} from "../state/environments";

const subagentWorking = SUBAGENT_TONE_COLORS.working;

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

const STATUS_LABELS: Record<string, string> = {
  preparing: "Preparing",
  queued: "Queued",
  starting: "Starting",
  running: "Running",
  waiting: "Waiting",
  idle: "Idle",
  completed: "Idle",
  interrupted: "Interrupted",
  failed: "Failed",
  cancelled: "Cancelled",
  rolled_back: "Rolled back",
};

export function ThreadScreen(props: {
  readonly thread: ThreadRef;
  /** Under another route. An open sheet unmounts so its Menu handler cannot act there. */
  readonly hidden: boolean;
  /** Each new value moves focus to the newest message once it has rendered. */
  readonly focusRequest: number;
  /** Shows another thread, a subagent's or a merge-back target; without it those cannot open. */
  readonly onOpenThread?: (thread: ThreadRef) => void;
  readonly onNewThread?: (project: ProjectRef) => void;
}) {
  const ref = props.thread;
  const { environmentId, threadId } = ref;
  // Reading the thread's state subscribes to its snapshot and live stream while this shows.
  const threadState = useAtomValue(environmentThreadDetails.stateAtom(ref));
  // Replaced on every streamed delta, so assistant text updates live.
  const visibleItems = useAtomValue(environmentThreadDetails.visibleTurnItemsAtom(ref));
  // Keeps its value through streamed deltas: runs, requests, and which items exist.
  const structure = useAtomValue(environmentThreadDetails.quietThreadAtom(ref));
  const queueWorkflow = useAtomValue(environmentThreadDetails.queueWorkflowAtom(ref));
  const pendingRequests = useAtomValue(environmentThreadDetails.pendingRequestsAtom(ref));
  const shell = useAtomValue(environmentThreadShells.threadShellAtom(ref));
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId));
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const environments = useAtomValue(environmentSummaries.environmentsAtom);
  const detailWorktreePath = useAtomValue(environmentThreadDetails.worktreePathAtom(ref));
  const turnSubagents = useAtomValue(environmentThreadDetails.turnSubagentsAtom(ref));
  const [sendError, setSendError] = useState<string | null>(null);
  const [openSheet, setSheet] = useState<ThreadSheetKind | null>(null);
  const sheet = props.hidden ? null : openSheet;
  // The toolbar button whose sheet last closed takes focus back.
  const [lastSheet, setLastSheet] = useState<ThreadSheetKind | null>(null);
  const closeSheet = () => {
    setLastSheet(sheet);
    setSheet(null);
  };
  const messageList = useRef<ThreadMessageListHandle>(null);
  const focusLatest = useCallback(() => messageList.current?.focusLatest(), []);
  const focusFirst = () => messageList.current?.focusFirst();
  // Focus guide destinations need mounted host views, so the hosts live in state.
  const [latestHost, setLatestHost] = useState<ViewInstance | null>(null);
  // An empty list clears the guide; `undefined` would keep the last destination.
  const entryDestinations = useMemo(
    () => (latestHost !== null && sheet === null ? [latestHost] : []),
    [latestHost, sheet],
  );
  const focusedRequest = useRef(0);
  // Native focus can move only once the newest block is mounted.
  useEffect(() => {
    if (latestHost === null || sheet !== null || props.hidden) return;
    if (focusedRequest.current === props.focusRequest) return;
    focusedRequest.current = props.focusRequest;
    focusLatest();
  }, [focusLatest, latestHost, props.focusRequest, props.hidden, sheet]);
  useTVEventHandler(
    useCallback(
      (event: { readonly eventType: string }) => {
        if (event.eventType === "playPause") focusLatest();
      },
      [focusLatest],
    ),
  );

  const rows = useMemo(() => deriveThreadRows(visibleItems), [visibleItems]);
  const thread = structure?.projection.thread ?? null;
  const runtime = useMemo(
    () => (structure ? deriveThreadStructureRuntime(structure.projection) : null),
    [structure],
  );
  const activityRun = useMemo(
    () => (structure ? deriveThreadActivityRun(structure.projection) : null),
    [structure],
  );
  const needsInput =
    pendingRequests !== null &&
    (pendingRequests.approvals.length > 0 || pendingRequests.userInputs.length > 0);
  const statusKey = runtime?.status ?? shell?.runtime?.status ?? "idle";
  const statusLabel = needsInput ? "Needs input" : (STATUS_LABELS[statusKey] ?? statusKey);
  const statusColor = needsInput
    ? colors.warning
    : statusKey === "running" || statusKey === "starting" || statusKey === "preparing"
      ? colors.success
      : statusKey === "failed"
        ? colors.danger
        : colors.textMuted;

  const title = thread?.title ?? shell?.title ?? "Thread";
  const projectId = thread?.projectId ?? shell?.projectId ?? null;
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const projectTitle = project?.title ?? "";
  // The thread's checkout as mobile resolves it: its worktree, else the project root.
  const worktreePath = detailWorktreePath ?? shell?.worktreePath ?? null;
  const cwd = worktreePath ?? project?.workspaceRoot ?? null;
  const agentsSegment = resolveSubagentPillSegment(turnSubagents);
  const { onOpenThread } = props;
  const openThread = (threadId: ThreadRef["threadId"]) =>
    onOpenThread?.({ environmentId, threadId });
  const environmentLabel =
    environments.find((entry) => entry.environmentId === environmentId)?.environmentLabel ?? "";
  const isCompacting = useMemo(
    () => threadIsCompacting({ runtime, visibleItems }),
    [runtime, visibleItems],
  );
  const dispatchMode = resolveThreadDispatchMode({
    runtime,
    activityRun,
    queueWorkflow,
    isCompacting,
  });
  const providers = serverConfig?.providers ?? EMPTY_PROVIDERS;

  const send = useCallback(
    async (text: string) => {
      if (thread === null) return false;
      setSendError(null);
      const error = await sendThreadMessage({
        environmentId,
        thread,
        text,
        dispatchMode,
        providers,
      });
      setSendError(error);
      return error === null;
    },
    [dispatchMode, environmentId, providers, thread],
  );

  useDevSendMessage(thread !== null && threadState.status === "live", send);
  useDevOpenSheet(thread !== null && threadState.status === "live", setSheet);

  const loadError = threadState.error._tag === "Some" ? threadState.error.value : null;
  const emptyLabel =
    threadState.status === "deleted"
      ? "This thread was deleted."
      : threadState.status === "live" || threadState.status === "cached"
        ? "No messages yet."
        : "Loading thread…";

  return (
    // Entering the conversation from outside lands on the newest message, whatever was focused last.
    <TVFocusGuideView style={styles.root} destinations={entryDestinations}>
      <View style={styles.column}>
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {[environmentLabel, projectTitle].filter(Boolean).join("  ·  ")}
            {environmentLabel || projectTitle ? "  ·  " : ""}
            <Text style={{ color: statusColor }}>{statusLabel}</Text>
            {threadState.status === "synchronizing" ? "  ·  Syncing…" : ""}
          </Text>
        </View>
        {loadError ? <Text style={styles.error}>{loadError}</Text> : null}
        <ThreadMessageList
          key={`messages:${environmentId}:${threadId}`}
          ref={messageList}
          rows={rows}
          latestHost={latestHost}
          latestHostRef={setLatestHost}
          emptyLabel={emptyLabel}
          environmentId={environmentId}
          threadId={threadId}
        />
        <TVFocusGuideView style={styles.toolbar} autoFocus>
          <FocusablePressable
            style={styles.headerButton}
            hasTVPreferredFocus={sheet === null && lastSheet === "thread"}
            onPress={() => setSheet("thread")}
          >
            <Text style={styles.headerButtonLabel}>Thread</Text>
          </FocusablePressable>
          {agentsSegment ? (
            <FocusablePressable
              style={styles.headerButton}
              hasTVPreferredFocus={sheet === null && lastSheet === "agents"}
              onPress={() => setSheet("agents")}
            >
              <Text style={styles.headerButtonLabel}>
                <Text style={{ color: turnSubagents?.liveCount ? subagentWorking : colors.text }}>
                  ●{" "}
                </Text>
                {`Agents ${agentsSegment.label}`}
              </Text>
            </FocusablePressable>
          ) : null}
          <FocusablePressable
            style={styles.headerButton}
            disabled={cwd === null || project === null}
            hasTVPreferredFocus={sheet === null && lastSheet === "git"}
            onPress={() => setSheet("git")}
          >
            <Text style={styles.headerButtonLabel}>Git</Text>
          </FocusablePressable>
          <FocusablePressable
            style={styles.headerButton}
            hasTVPreferredFocus={sheet === null && lastSheet === "terminal"}
            onPress={() => setSheet("terminal")}
          >
            <Text style={styles.headerButtonLabel}>Terminal</Text>
          </FocusablePressable>
          <View style={styles.headerSpacer} />
          <FocusablePressable style={styles.headerButton} onPress={focusFirst}>
            <Text style={styles.headerButtonLabel}>Top</Text>
          </FocusablePressable>
          <FocusablePressable style={styles.headerButton} onPress={focusLatest}>
            <Text style={styles.headerButtonLabel}>Latest</Text>
          </FocusablePressable>
        </TVFocusGuideView>
        <ThreadReplyBox
          key={`reply:${environmentId}:${threadId}`}
          threadKey={`${environmentId}:${threadId}`}
          sendLabel={dispatchMode === "queue" ? "Queue" : "Send"}
          hint={
            dispatchMode === "auto"
              ? "A turn is running: Send steers it."
              : dispatchMode === "queue"
                ? "The workspace is being set up: Send queues the message."
                : null
          }
          error={sendError}
          disabled={thread === null || threadState.status === "deleted"}
          onSend={send}
        />
      </View>
      {sheet === "thread" ? (
        <ThreadActionsSheet
          environmentId={environmentId}
          threadId={threadId}
          archived={thread?.archivedAt != null}
          onClose={closeSheet}
          {...(props.onNewThread ? { onNewThread: props.onNewThread } : {})}
        />
      ) : sheet === "git" && cwd !== null && project !== null ? (
        <ThreadGitSheet
          environmentId={environmentId}
          threadId={threadId}
          cwd={cwd}
          gitRootCwd={project.workspaceRoot}
          worktreePath={worktreePath}
          currentBranch={shell?.branch ?? null}
          onOpenThread={openThread}
          onClose={closeSheet}
        />
      ) : sheet === "terminal" ? (
        <ThreadTerminalSheet
          environmentId={environmentId}
          threadId={threadId}
          workspaceRoot={project?.workspaceRoot ?? null}
          worktreePath={worktreePath}
          projectScripts={
            project
              ? resolveProjectScripts(serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS, project)
              : []
          }
          onClose={closeSheet}
        />
      ) : sheet === "agents" ? (
        <SubagentsSheet
          turn={turnSubagents}
          onOpenThread={openThread}
          canOpenThreads={onOpenThread !== undefined}
          onClose={closeSheet}
        />
      ) : null}
    </TVFocusGuideView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, alignItems: "center" },
  column: { flex: 1, width: "100%", maxWidth: 1200, paddingTop: 48 },
  header: { gap: 4, marginBottom: 12 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 20, paddingTop: 16 },
  headerSpacer: { flex: 1 },
  headerButton: { paddingHorizontal: 24, paddingVertical: 14 },
  headerButtonLabel: { color: colors.text, fontSize: 26, fontWeight: "600" },
  title: { color: colors.text, fontSize: 44, fontWeight: "700" },
  meta: { color: colors.textMuted, ...typography.small },
  error: { color: colors.danger, ...typography.small },
});
