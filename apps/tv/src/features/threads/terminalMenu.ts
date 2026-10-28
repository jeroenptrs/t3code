import { DEFAULT_TERMINAL_ID, type TerminalSummary } from "@t3tools/contracts";
import { nextTerminalId, resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";

// Ported from apps/mobile/src/features/terminal/terminalMenu.ts.

export interface TerminalMenuSession {
  readonly terminalId: string;
  readonly cwd: string | null;
  readonly status: TerminalSummary["status"];
  readonly hasRunningSubprocess: boolean;
  readonly displayLabel: string;
}

const byTerminalId = (left: TerminalMenuSession, right: TerminalMenuSession) =>
  left.terminalId.localeCompare(right.terminalId, undefined, { numeric: true });

export function basename(input: string | null): string | null {
  if (!input) return null;
  const normalized = input.replace(/\/+$/, "");
  if (normalized.length === 0) return "/";
  const segments = normalized.split("/");
  return segments[segments.length - 1] ?? normalized;
}

export function getTerminalStatusLabel(input: {
  readonly status: TerminalMenuSession["status"];
  readonly hasRunningSubprocess?: boolean;
}): string {
  if (input.status === "running") return input.hasRunningSubprocess ? "Task running" : "Ready";
  if (input.status === "starting") return "Starting";
  if (input.status === "exited") return "Exited";
  if (input.status === "error") return "Error";
  return "Not started";
}

/** The thread's live sessions from the environment's terminal metadata, by terminal id. */
export function buildTerminalMenuSessions(
  summaries: ReadonlyArray<TerminalSummary>,
  threadId: string,
): ReadonlyArray<TerminalMenuSession> {
  return summaries
    .filter(
      (summary) =>
        summary.threadId === threadId &&
        (summary.status === "running" || summary.status === "starting"),
    )
    .map((summary) => ({
      terminalId: summary.terminalId,
      cwd: summary.cwd,
      status: summary.status,
      hasRunningSubprocess: summary.hasRunningSubprocess,
      displayLabel: resolveTerminalSessionLabel(summary.terminalId, summary),
    }))
    .sort(byTerminalId);
}

export function nextOpenTerminalId(input: {
  readonly listedTerminalIds: ReadonlyArray<string>;
  readonly uniqueSuffix?: string;
}): string {
  return nextTerminalId(
    input.listedTerminalIds.filter((id) => id.trim().length > 0),
    input.uniqueSuffix,
  );
}

export function resolveProjectScriptTerminalId(input: {
  readonly existingTerminalIds: ReadonlyArray<string>;
  readonly hasRunningTerminal: boolean;
  readonly uniqueSuffix?: string;
}): string {
  if (!input.hasRunningTerminal && input.uniqueSuffix === undefined) return DEFAULT_TERMINAL_ID;
  return nextTerminalId(input.existingTerminalIds, input.uniqueSuffix);
}
