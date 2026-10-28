import {
  formatSubagentDisplayTitle,
  subagentDetailPreview,
} from "@t3tools/client-runtime/state/subagent-display";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import type { OrchestrationV2Subagent } from "@t3tools/contracts";

// Ported from apps/mobile/src/features/threads/threadAgentsPresentation.ts and
// subagent-card-presentation.ts.

const PROMPT_TITLE_LIMIT = 80;

/** Dark values of mobile's SubagentStatusDot tones: adaptive-{sky,emerald,rose}-600-400. */
export const SUBAGENT_TONE_COLORS = {
  working: "#00bcff",
  completed: "#00d492",
  failed: "#ff637e",
  stopped: "#838383",
} as const;

export type SubagentTone = keyof typeof SUBAGENT_TONE_COLORS;

type PresentedSubagent = Pick<
  OrchestrationV2Subagent,
  "title" | "prompt" | "status" | "progress" | "result"
>;

function title(subagent: PresentedSubagent): string {
  const explicit = subagent.title?.trim();
  if (explicit) return formatSubagentDisplayTitle(explicit);
  const prompt = subagent.prompt.trim();
  if (prompt.length === 0) return "Subagent";
  return prompt.length > PROMPT_TITLE_LIMIT
    ? `${prompt.slice(0, PROMPT_TITLE_LIMIT - 3)}...`
    : prompt;
}

function tone(status: OrchestrationV2Subagent["status"]): SubagentTone {
  if (isActiveSubagentStatus(status)) return "working";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "stopped";
}

function statusLabel(status: OrchestrationV2Subagent["status"]): string {
  switch (status) {
    case "pending":
    case "running":
      return "Working";
    case "waiting":
      return "Waiting";
    case "idle":
      return "Idle";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
  }
}

/** The preview without markdown links, code ticks, or bullets, on one line. */
function cardDetail(detail: string | null): string | null {
  if (!detail || /^Child task ended with status\b/i.test(detail)) return null;
  return (
    detail
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`/g, "")
      .replace(/^[ \t]*[-*][ \t]+/gm, "")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

export function presentSubagent(subagent: PresentedSubagent) {
  return {
    title: title(subagent),
    statusLabel: statusLabel(subagent.status),
    tone: tone(subagent.status),
    detail: cardDetail(subagentDetailPreview(subagent)),
  };
}
