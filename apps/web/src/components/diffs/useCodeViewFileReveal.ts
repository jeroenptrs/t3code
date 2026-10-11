import type { CodeViewScrollTarget, SelectedLineRange } from "@pierre/diffs";
import { useCallback, useEffect, useRef, useState } from "react";

interface FileRevealHandle {
  getInstance(): object | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

/** Room left above a revealed range, so it does not read as the first line of the file. */
const RANGE_LEAD_IN_PX = 48;

// Wait for a mounted viewer and expanded rows, then apply each tree click once.
// Keep scope stable until the diff or external file selection changes.
// A range puts those lines just under the sticky file header, with a little of what leads into
// them showing; the file is scrolled to first, so a range the viewer cannot place (lines outside
// every hunk) still lands on the file.
export function useCodeViewFileReveal<TScope>(
  viewer: FileRevealHandle | null,
  scope: TScope,
  readyFileKeys?: ReadonlyArray<string>,
) {
  const [request, setRequest] = useState<{
    fileKey: string;
    range: SelectedLineRange | undefined;
    scope: TScope;
  } | null>(null);
  const handledRequest = useRef<typeof request>(null);

  useEffect(() => {
    if (request === null || handledRequest.current === request) return;
    if (request.scope !== scope) {
      handledRequest.current = request;
      return;
    }
    if (!viewer?.getInstance() || (readyFileKeys && !readyFileKeys.includes(request.fileKey)))
      return;

    viewer.scrollTo({ type: "item", id: request.fileKey, align: "start" });
    if (request.range !== undefined) {
      viewer.scrollTo({
        type: "range",
        id: request.fileKey,
        range: request.range,
        align: "start",
        offset: RANGE_LEAD_IN_PX,
      });
    }
    handledRequest.current = request;
  }, [request, scope, viewer, readyFileKeys]);

  return useCallback(
    (fileKey: string, range?: SelectedLineRange) => setRequest({ fileKey, range, scope }),
    [scope],
  );
}
