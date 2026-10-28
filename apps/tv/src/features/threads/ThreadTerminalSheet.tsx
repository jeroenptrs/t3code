import { useAtomValue } from "@effect/atom-react";
import {
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type EnvironmentId,
  type ProjectScript,
  type TerminalSummary,
  type ThreadId,
} from "@t3tools/contracts";
import {
  projectScriptCwd,
  projectScriptMenuLabel,
  projectScriptRuntimeEnv,
  projectScriptTerminalInput,
} from "@t3tools/shared/projectScripts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import * as ExpoCrypto from "expo-crypto";

import { useTvNavigation } from "../../navigation/TvNavigation";
import { terminalEnvironment } from "../terminal/state";
import { stagePendingTerminalLaunch } from "./terminalLaunch";
import {
  basename,
  buildTerminalMenuSessions,
  getTerminalStatusLabel,
  nextOpenTerminalId,
  resolveProjectScriptTerminalId,
} from "./terminalMenu";
import { ThreadSheet, type ThreadSheetRow } from "./ThreadSheet";
import { useEnvironmentScope } from "./vcs";

const NO_METADATA = Atom.make(AsyncResult.initial<ReadonlyArray<TerminalSummary>>());

/**
 * Mobile's Terminal header menu (ThreadGitControls.tsx) as a sheet: project scripts, the thread's
 * live sessions, and a new terminal. Each opens the terminal route; a script stages its command
 * as the new terminal's initial input first, as mobile's handleRunProjectScript does.
 */
export function ThreadTerminalSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The project checkout, or null when the thread's project is not known yet. */
  readonly workspaceRoot: string | null;
  readonly worktreePath: string | null;
  readonly projectScripts: ReadonlyArray<ProjectScript>;
  readonly onClose: () => void;
}) {
  const { environmentId, threadId, workspaceRoot, worktreePath } = props;
  const navigation = useTvNavigation();
  const canRead = useEnvironmentScope(environmentId, AuthTerminalReadScope);
  const canOperate = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const metadataResult = useAtomValue(
    canRead ? terminalEnvironment.metadata({ environmentId, input: null }) : NO_METADATA,
  );
  const metadata =
    metadataResult._tag === "Failure" ? null : Option.getOrNull(AsyncResult.value(metadataResult));
  const sessions = buildTerminalMenuSessions(metadata ?? [], threadId);
  const sessionIds = sessions.map((session) => session.terminalId);
  // Without metadata a numbered id could land on a host session this client cannot see.
  const uniqueSuffix = () =>
    metadata === null || !canRead ? { uniqueSuffix: ExpoCrypto.randomUUID() } : {};

  const canOpen = workspaceRoot !== null && (canRead || canOperate);
  const canOperateTerminal = canOpen && canOperate;
  const open = (terminalId: string) => {
    props.onClose();
    navigation.openTerminal({ environmentId, threadId }, terminalId);
  };

  const runScript = (script: ProjectScript) => {
    if (!canOperateTerminal || workspaceRoot === null) return;
    const terminalId = resolveProjectScriptTerminalId({
      existingTerminalIds: sessionIds,
      hasRunningTerminal: sessions.length > 0,
      ...uniqueSuffix(),
    });
    const project = { cwd: workspaceRoot };
    stagePendingTerminalLaunch({
      target: { environmentId, threadId, terminalId },
      launch: {
        cwd: projectScriptCwd({ project, worktreePath }),
        worktreePath,
        env: projectScriptRuntimeEnv({ project, worktreePath }),
        initialInput: projectScriptTerminalInput(script.command),
      },
    });
    open(terminalId);
  };

  const rows: Array<ThreadSheetRow> = [
    ...props.projectScripts.map((script): ThreadSheetRow => ({
      key: `script:${script.id}`,
      label: projectScriptMenuLabel(script),
      subtitle: script.command,
      disabled: !canOperateTerminal,
      onPress: () => runScript(script),
    })),
    ...(props.projectScripts.length === 0
      ? [
          {
            key: "no-scripts",
            label: "No project scripts",
            subtitle: "This project has no saved scripts yet",
            disabled: true,
          },
        ]
      : []),
    ...sessions.map((session): ThreadSheetRow => ({
      key: `session:${session.terminalId}`,
      label: session.displayLabel,
      subtitle: [getTerminalStatusLabel(session), basename(session.cwd)]
        .filter(Boolean)
        .join(" · "),
      disabled: !canOpen,
      onPress: () => open(session.terminalId),
    })),
    {
      key: "new",
      label: "Open new terminal",
      subtitle: "Start another shell for this thread",
      disabled: !canOperateTerminal,
      onPress: () => open(nextOpenTerminalId({ listedTerminalIds: sessionIds, ...uniqueSuffix() })),
    },
  ];

  return <ThreadSheet title="Terminal" rows={rows} onClose={props.onClose} />;
}
