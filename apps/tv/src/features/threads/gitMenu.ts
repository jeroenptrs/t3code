import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { VcsStatusResult } from "@t3tools/contracts";

// Ported from apps/mobile/src/features/threads/ThreadGitControls.tsx.

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const headLength = Math.ceil((maxLength - 1) / 2);
  const tailLength = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, headLength)}…${value.slice(value.length - tailLength)}`;
}

export function compactMenuBranchLabel(branch: string): string {
  return truncateMiddle(branch, 40);
}

/** "3 changed · 1 ahead · PR #12", or "Clean", for the branch row. */
export function compactMenuStatus(gitStatus: VcsStatusResult | null): string {
  if (!gitStatus) return "Checking status";
  if (!gitStatus.isRepo) return "Not a repo";
  const parts: string[] = [];
  if (gitStatus.hasWorkingTreeChanges) {
    parts.push(`${gitStatus.workingTree.files.length} changed`);
  } else if (gitStatus.aheadCount === 0 && gitStatus.behindCount === 0) {
    parts.push("Clean");
  }
  if (gitStatus.aheadCount > 0) parts.push(`${gitStatus.aheadCount} ahead`);
  if (gitStatus.behindCount > 0) parts.push(`${gitStatus.behindCount} behind`);
  if (gitStatus.pr?.state === "open") {
    const { shortLabel } = sourceControlClients.get(
      gitStatus.sourceControlProvider?.kind,
    ).changeRequest;
    parts.push(`${shortLabel} #${gitStatus.pr.number}`);
  }
  return parts.join(" · ");
}
