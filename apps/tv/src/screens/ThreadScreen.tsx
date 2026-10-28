import { useAtomValue } from "@effect/atom-react";
import {
  deriveThreadActivityRun,
  deriveThreadStructureRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import type { ServerProvider } from "@t3tools/contracts";
import { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, TVFocusGuideView, useTVEventHandler, View } from "react-native";

import { FocusablePressable } from "../components/FocusablePressable";
import { colors, typography } from "../components/theme";
import { useDevSendMessage } from "../features/threads/devOpenThread";
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
import { ThreadReplyBox } from "../features/threads/ThreadReplyBox";
import { deriveThreadRows } from "../features/threads/threadRows";
import { threadNeighbours, type Route, type ThreadRef } from "../navigation/stack";
import {
  environmentProjects,
  environmentSummaries,
  environmentThreadShells,
  serverEnvironment,
} from "../state/environments";

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
  readonly route: Extract<Route, { name: "thread" }>;
  readonly onBack: () => void;
  readonly onOpenSibling: (thread: ThreadRef) => void;
}) {
  const ref = props.route.thread;
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
  const [sendError, setSendError] = useState<string | null>(null);
  // After Previous or Next, focus stays on the header so the reader can keep stepping.
  const [steppedFromHeader, setSteppedFromHeader] = useState(false);
  const messageList = useRef<ThreadMessageListHandle>(null);
  const { previous, next } = threadNeighbours(props.route);
  const { onOpenSibling } = props;
  const openSibling = (thread: ThreadRef) => {
    setSteppedFromHeader(true);
    setSendError(null);
    onOpenSibling(thread);
  };
  const focusLatest = useCallback(() => messageList.current?.focusLatest(), []);
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
  const projectTitle = projects.find((project) => project.id === projectId)?.title ?? "";
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

  const loadError = threadState.error._tag === "Some" ? threadState.error.value : null;
  const emptyLabel =
    threadState.status === "deleted"
      ? "This thread was deleted."
      : threadState.status === "live" || threadState.status === "cached"
        ? "No messages yet."
        : "Loading thread…";

  return (
    <View style={styles.root}>
      <View style={styles.column}>
        <TVFocusGuideView style={styles.header} autoFocus>
          <FocusablePressable style={styles.headerButton} onPress={props.onBack}>
            <Text style={styles.headerButtonLabel}>‹ Back</Text>
          </FocusablePressable>
          <View style={styles.headerText}>
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
          <FocusablePressable
            style={styles.headerButton}
            disabled={previous === null}
            onPress={() => previous && openSibling(previous)}
          >
            <Text style={styles.headerButtonLabel}>‹ Previous</Text>
          </FocusablePressable>
          <FocusablePressable
            style={styles.headerButton}
            disabled={next === null}
            onPress={() => next && openSibling(next)}
          >
            <Text style={styles.headerButtonLabel}>Next ›</Text>
          </FocusablePressable>
          <FocusablePressable style={styles.headerButton} onPress={focusLatest}>
            <Text style={styles.headerButtonLabel}>Latest</Text>
          </FocusablePressable>
        </TVFocusGuideView>
        {loadError ? <Text style={styles.error}>{loadError}</Text> : null}
        <ThreadMessageList
          key={`${environmentId}:${threadId}`}
          ref={messageList}
          rows={rows}
          claimInitialFocus={!steppedFromHeader}
          emptyLabel={emptyLabel}
          environmentId={environmentId}
          threadId={threadId}
        />
        <ThreadReplyBox
          key={`${environmentId}:${threadId}`}
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
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, alignItems: "center" },
  column: { flex: 1, width: "100%", maxWidth: 1200, paddingTop: 48 },
  header: { flexDirection: "row", alignItems: "center", gap: 20, marginBottom: 12 },
  headerText: { flex: 1, gap: 4, marginHorizontal: 12 },
  headerButton: { paddingHorizontal: 24, paddingVertical: 14 },
  headerButtonLabel: { color: colors.text, fontSize: 26, fontWeight: "600" },
  title: { color: colors.text, fontSize: 44, fontWeight: "700" },
  meta: { color: colors.textMuted, ...typography.small },
  error: { color: colors.danger, ...typography.small },
});
