import type { CodeViewScrollTarget, SelectedLineRange } from "@pierre/diffs";
import { useState } from "react";

interface FileRevealHandle {
  getInstance(): object | undefined;
  getItem(id: string): unknown;
  scrollTo(target: CodeViewScrollTarget): void;
}

/** Room left above a revealed range, so it does not read as the first line of the file. */
const RANGE_LEAD_IN_PX = 48;

/**
 * Scrolls a code view to a file. `attach` is the viewer's ref and `flush` its post-render
 * handler, so a reveal asked before the viewer mounts, or for a file it does not hold yet, is
 * positioned once it does. A reveal belongs to the diff it was asked of, so detaching the viewer,
 * such as remounting it for another diff scope, drops it.
 */
export function createCodeViewFileReveal() {
  let viewer: FileRevealHandle | null = null;
  let pending: { fileKey: string; range: SelectedLineRange | undefined } | null = null;
  const flush = () => {
    if (pending === null || viewer === null) return;
    if (!viewer.getInstance() || viewer.getItem(pending.fileKey) === undefined) return;
    viewer.scrollTo({ type: "item", id: pending.fileKey, align: "start" });
    if (pending.range !== undefined) {
      viewer.scrollTo({
        type: "range",
        id: pending.fileKey,
        range: pending.range,
        align: "start",
        offset: RANGE_LEAD_IN_PX,
      });
    }
    pending = null;
  };
  return {
    attach(next: FileRevealHandle | null) {
      if (viewer !== null && next !== viewer) pending = null;
      viewer = next;
      flush();
    },
    request(fileKey: string, range?: SelectedLineRange) {
      pending = { fileKey, range };
      flush();
    },
    flush,
  };
}

export function useCodeViewFileReveal() {
  const [reveal] = useState(createCodeViewFileReveal);
  return reveal;
}
