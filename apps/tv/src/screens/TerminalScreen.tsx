import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  DEFAULT_TERMINAL_ID,
  sessionGrantsScope,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type EnvironmentId,
  type TerminalAttachInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useMemo, useRef, useState } from "react";
import { StyleSheet, Text, TVFocusGuideView, useWindowDimensions, View } from "react-native";

import { FocusablePressable } from "../components/FocusablePressable";
import { TvTextInput } from "../components/TvTextInput";
import { colors, typography } from "../components/theme";
import { takeDevTerminalInput } from "../features/terminal/devTerminal";
import { terminalEnvironment } from "../features/terminal/state";
import {
  TERMINAL_GLYPH_WIDTH,
  TERMINAL_HORIZONTAL_PADDING,
  TerminalOutput,
} from "../features/terminal/TerminalOutput";
import { useTerminalLines } from "../features/terminal/useTerminalLines";
import { takePendingTerminalLaunch } from "../features/threads/terminalLaunch";
import { tvAtomRegistry } from "../state/atom-registry";
import {
  environmentProjects,
  environmentSession,
  environmentThreadShells,
} from "../state/environments";

const TERMINAL_ROWS = 40;
const SCREEN_HORIZONTAL_MARGIN = 64;

const STATUS_LABELS: Record<string, string> = {
  starting: "Starting",
  running: "Running",
  exited: "Exited",
  error: "Error",
  closed: "Not running",
};

function hasScope(
  result: AsyncResult.AsyncResult<AuthSessionState, unknown>,
  scope: AuthEnvironmentScope,
): boolean {
  const session = Option.getOrNull(AsyncResult.value(result));
  return result._tag !== "Failure" && session !== null && sessionGrantsScope(session, scope);
}

const readScope = (environmentId: EnvironmentId, scope: AuthEnvironmentScope) =>
  hasScope(tvAtomRegistry.get(environmentSession.sessionStateAtom(environmentId)), scope);

/**
 * A line-mode view of a thread's terminal. tvOS has no terminal emulator to draw into, so the
 * output is parsed into styled lines and input goes through a command line and a few keys.
 */
export function TerminalScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId?: string;
  readonly onClose: () => void;
}) {
  const { environmentId, threadId, onClose } = props;
  const terminalId = props.terminalId ?? DEFAULT_TERMINAL_ID;
  const sessionState = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const canOperate = hasScope(sessionState, AuthTerminalOperateScope);
  const canRead = hasScope(sessionState, AuthTerminalReadScope);
  const shell = useAtomValue(environmentThreadShells.threadShellAtom({ environmentId, threadId }));
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId));
  const metadata = useAtomValue(terminalEnvironment.metadata({ environmentId, input: null }));
  const { width } = useWindowDimensions();

  const [grid] = useState(() => ({
    cols: Math.max(
      20,
      Math.floor(
        (width - 2 * (SCREEN_HORIZONTAL_MARGIN + TERMINAL_HORIZONTAL_PADDING)) /
          TERMINAL_GLYPH_WIDTH,
      ),
    ),
    rows: TERMINAL_ROWS,
  }));
  const [pendingLaunch] = useState(() =>
    takePendingTerminalLaunch({ environmentId, threadId, terminalId }),
  );
  const [session] = useState(() =>
    terminalEnvironment.createSession({
      target: { environmentId, threadId, terminalId },
      gridSize: grid,
      initialInput: pendingLaunch?.initialInput ?? takeDevTerminalInput(),
      canOperate: () => readScope(environmentId, AuthTerminalOperateScope),
      onExit: onClose,
    }),
  );

  const summary = Option.getOrNull(AsyncResult.value(metadata))?.find(
    (entry) => entry.threadId === threadId && entry.terminalId === terminalId,
  );
  // A staged launch and an existing session keep their location; a new one opens where the thread works.
  const metadataSettled = !canRead || metadata._tag !== "Initial";
  const workspaceRoot = projects.find((project) => project.id === shell?.projectId)?.workspaceRoot;
  const candidate = pendingLaunch
    ? { cwd: pendingLaunch.cwd, worktreePath: pendingLaunch.worktreePath }
    : summary !== undefined
      ? { cwd: summary.cwd, worktreePath: summary.worktreePath }
      : metadataSettled && workspaceRoot !== undefined
        ? { cwd: shell?.worktreePath ?? workspaceRoot, worktreePath: shell?.worktreePath ?? null }
        : null;
  const [location, setLocation] = useState(candidate);
  if (location === null && candidate !== null) setLocation(candidate);
  const resolvedLocation = location ?? candidate;

  const attachInput = useMemo<TerminalAttachInput | null>(
    () =>
      resolvedLocation === null
        ? null
        : {
            threadId,
            terminalId,
            cwd: resolvedLocation.cwd,
            worktreePath: resolvedLocation.worktreePath,
            cols: grid.cols,
            rows: grid.rows,
            ...(pendingLaunch?.env ? { env: pendingLaunch.env } : {}),
            ...(pendingLaunch ? { restartIfNotRunning: true } : {}),
          },
    [grid, pendingLaunch, resolvedLocation, terminalId, threadId],
  );
  const observing = !canOperate && canRead;
  useAtomMount(
    session.driver(
      canOperate && attachInput !== null
        ? { kind: "attached", input: attachInput }
        : observing
          ? { kind: "observing" }
          : null,
    ),
  );
  const outputAtom = useMemo(
    () =>
      canOperate && attachInput !== null
        ? terminalEnvironment.attach({ environmentId, input: attachInput })
        : observing
          ? terminalEnvironment.observe({ environmentId, input: { threadId, terminalId } })
          : null,
    [attachInput, canOperate, environmentId, observing, terminalId, threadId],
  );
  const terminal = useTerminalLines(outputAtom);
  const followingRef = useRef(true);
  const [command, setCommand] = useState("");
  const isRunning = terminal.status === "running" || terminal.status === "starting";
  const canType = canOperate && isRunning;

  const write = (data: string) => {
    if (!readScope(environmentId, AuthTerminalOperateScope)) return;
    followingRef.current = true;
    void runAtomCommand(tvAtomRegistry, terminalEnvironment.write, {
      environmentId,
      input: { threadId, terminalId, data },
    });
  };
  const clear = () => {
    if (!readScope(environmentId, AuthTerminalOperateScope)) return;
    followingRef.current = true;
    void runAtomCommand(tvAtomRegistry, terminalEnvironment.clear, {
      environmentId,
      input: { threadId, terminalId },
    });
  };
  const submit = () => {
    if (!canType) return;
    write(`${command}\r`);
    setCommand("");
  };

  const label = summary?.label || (terminalId === DEFAULT_TERMINAL_ID ? "Terminal" : terminalId);
  const statusColor = isRunning
    ? colors.success
    : terminal.status === "error"
      ? colors.danger
      : colors.textMuted;
  const emptyLabel =
    !canRead && !canOperate
      ? "This device may not view terminals in this environment."
      : resolvedLocation === null && !observing
        ? "Finding the thread's workspace…"
        : isRunning
          ? "No output yet."
          : "Starting the shell…";

  return (
    <View style={styles.root}>
      <TVFocusGuideView style={styles.header} autoFocus>
        <FocusablePressable
          style={styles.headerButton}
          onPress={onClose}
          onFocus={() => (followingRef.current = true)}
        >
          <Text style={styles.buttonLabel}>‹ Close</Text>
        </FocusablePressable>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>
            {label}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {resolvedLocation?.cwd ?? shell?.title ?? ""}
            {resolvedLocation || shell ? "  ·  " : ""}
            <Text style={{ color: statusColor }}>
              {STATUS_LABELS[terminal.status] ?? terminal.status}
            </Text>
            {observing ? "  ·  Read only" : ""}
          </Text>
        </View>
      </TVFocusGuideView>
      {terminal.error ? <Text style={styles.error}>{terminal.error}</Text> : null}
      <TerminalOutput lines={terminal.lines} followingRef={followingRef} emptyLabel={emptyLabel} />
      {canOperate ? (
        <View style={styles.commandRow}>
          <View style={styles.inputColumn}>
            <TvTextInput
              value={command}
              onChangeText={setCommand}
              onFocus={() => (followingRef.current = true)}
              placeholder="Command… (select to type or dictate)"
              editable={canType}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="send"
              onSubmitEditing={submit}
              hasTVPreferredFocus
            />
          </View>
          <QuickKey label="Ctrl+C" disabled={!canType} onPress={() => write("\x03")} />
          <QuickKey label="Enter" disabled={!canType} onPress={() => write("\r")} />
          <QuickKey label="Clear" disabled={!canOperate} onPress={clear} />
        </View>
      ) : null}
    </View>
  );
}

function QuickKey(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <FocusablePressable style={styles.quickKey} disabled={props.disabled} onPress={props.onPress}>
      <Text style={styles.buttonLabel}>{props.label}</Text>
    </FocusablePressable>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: SCREEN_HORIZONTAL_MARGIN,
    paddingTop: 40,
    paddingBottom: 32,
    gap: 16,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 20 },
  headerText: { flex: 1, gap: 2, marginHorizontal: 12 },
  headerButton: { paddingHorizontal: 24, paddingVertical: 12 },
  buttonLabel: { color: colors.text, fontSize: 26, fontWeight: "600" },
  title: { color: colors.text, fontSize: 36, fontWeight: "700" },
  meta: { color: colors.textMuted, ...typography.small },
  error: { color: colors.danger, ...typography.small },
  commandRow: { flexDirection: "row", alignItems: "center", gap: 16 },
  inputColumn: { flex: 1 },
  quickKey: { paddingHorizontal: 24, paddingVertical: 20 },
});
