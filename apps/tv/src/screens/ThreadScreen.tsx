import { useAtomValue } from "@effect/atom-react";
import {
  deriveThreadActivityRun,
  deriveThreadStructureRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BackHandler, StyleSheet, Text, View } from "react-native";

import { FocusablePressable } from "../components/FocusablePressable";
import { colors, typography } from "../components/theme";
import { useDevSendMessage } from "../features/threads/devOpenThread";
import {
  resolveThreadDispatchMode,
  sendThreadMessage,
} from "../features/threads/sendThreadMessage";
import { environmentThreadDetails } from "../features/threads/state";
import { ThreadMessageList } from "../features/threads/ThreadMessageList";
import { ThreadReplyBox } from "../features/threads/ThreadReplyBox";
import { deriveThreadRows } from "../features/threads/threadRows";
import { environmentProjects, environmentThreadShells } from "../state/environments";

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
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onBack: () => void;
}) {
  const ref = useMemo(
    () => ({ environmentId: props.environmentId, threadId: props.threadId }),
    [props.environmentId, props.threadId],
  );
  // Reading the thread's state subscribes to its snapshot and live stream while this shows.
  const threadState = useAtomValue(environmentThreadDetails.stateAtom(ref));
  // Replaced on every streamed delta, so assistant text updates live.
  const visibleItems = useAtomValue(environmentThreadDetails.visibleTurnItemsAtom(ref));
  // Keeps its value through streamed deltas: runs, requests, and which items exist.
  const structure = useAtomValue(environmentThreadDetails.quietThreadAtom(ref));
  const queueWorkflow = useAtomValue(environmentThreadDetails.queueWorkflowAtom(ref));
  const pendingRequests = useAtomValue(environmentThreadDetails.pendingRequestsAtom(ref));
  const shell = useAtomValue(environmentThreadShells.threadShellAtom(ref));
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(props.environmentId));
  const [sendError, setSendError] = useState<string | null>(null);

  // The remote's Menu button returns to the environment. Handlers run newest first, so this
  // one runs before the app root's, which would return to the connections screen.
  const { onBack } = props;
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onBack();
      return true;
    });
    return () => subscription.remove();
  }, [onBack]);

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
  const dispatchMode = resolveThreadDispatchMode({ runtime, activityRun, queueWorkflow });

  const send = useCallback(
    async (text: string) => {
      if (thread === null) return false;
      setSendError(null);
      const error = await sendThreadMessage({
        environmentId: props.environmentId,
        thread,
        text,
        dispatchMode,
      });
      setSendError(error);
      return error === null;
    },
    [dispatchMode, props.environmentId, thread],
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
        <View style={styles.header}>
          <FocusablePressable style={styles.backButton} onPress={props.onBack}>
            <Text style={styles.backLabel}>‹ Threads</Text>
          </FocusablePressable>
          <View style={styles.headerText}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {projectTitle}
              {projectTitle ? "  ·  " : ""}
              <Text style={{ color: statusColor }}>{statusLabel}</Text>
              {threadState.status === "synchronizing" ? "  ·  Syncing…" : ""}
            </Text>
          </View>
        </View>
        {loadError ? <Text style={styles.error}>{loadError}</Text> : null}
        <ThreadMessageList rows={rows} emptyLabel={emptyLabel} />
        <ThreadReplyBox
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
  header: { flexDirection: "row", alignItems: "center", gap: 32, marginBottom: 12 },
  headerText: { flex: 1, gap: 4 },
  backButton: { paddingHorizontal: 24, paddingVertical: 14 },
  backLabel: { color: colors.text, fontSize: 26, fontWeight: "600" },
  title: { color: colors.text, fontSize: 44, fontWeight: "700" },
  meta: { color: colors.textMuted, ...typography.small },
  error: { color: colors.danger, ...typography.small },
});
