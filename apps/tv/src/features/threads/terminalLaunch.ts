import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

/**
 * A launch the thread's Terminal menu staged for the terminal route it is about to open, ported
 * from apps/mobile/src/features/terminal/terminalLaunchContext.ts. The terminal view takes it
 * once, when it opens `terminalId`, and opens the shell with this cwd and env, then writes
 * `initialInput` (a project script's command line, ending in a carriage return).
 */
export interface PendingTerminalLaunch {
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly env?: Record<string, string>;
  readonly initialInput?: string;
}

export interface PendingTerminalLaunchTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

const pendingTerminalLaunches = new Map<string, PendingTerminalLaunch>();

const launchKey = (target: PendingTerminalLaunchTarget) =>
  `${target.environmentId}:${target.threadId}:${target.terminalId}`;

export function stagePendingTerminalLaunch(input: {
  readonly target: PendingTerminalLaunchTarget;
  readonly launch: PendingTerminalLaunch;
}): void {
  pendingTerminalLaunches.set(launchKey(input.target), {
    ...input.launch,
    ...(input.launch.env ? { env: { ...input.launch.env } } : {}),
  });
}

/** Returns the staged launch for `target` and forgets it, so a reopened terminal does not rerun it. */
export function takePendingTerminalLaunch(
  target: PendingTerminalLaunchTarget,
): PendingTerminalLaunch | null {
  const key = launchKey(target);
  const launch = pendingTerminalLaunches.get(key) ?? null;
  pendingTerminalLaunches.delete(key);
  return launch;
}
