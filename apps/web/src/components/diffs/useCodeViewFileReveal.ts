import type { CodeViewScrollTarget, SelectedLineRange } from "@pierre/diffs";
import { useCallback, useEffect, useRef, useState } from "react";

interface FileRevealHandle {
  getInstance(): object | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

// Wait for a mounted viewer and expanded rows, then apply each tree click once.
// Keep scope stable until the diff or external file selection changes.
// A range centers those lines; the file is scrolled to first, so a range the viewer cannot place
// (lines outside every hunk) still lands on the file.
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
        align: "center",
      });
    }
    handledRequest.current = request;
  }, [request, scope, viewer, readyFileKeys]);

  return useCallback(
    (fileKey: string, range?: SelectedLineRange) => setRequest({ fileKey, range, scope }),
    [scope],
  );
}
