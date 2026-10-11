import type { CodeViewScrollTarget, SelectedLineRange } from "@pierre/diffs";
import { useEffect, useRef, useState } from "react";

interface FileRevealHandle {
  getInstance(): object | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

/** Room left above a revealed range, so it does not read as the first line of the file. */
const RANGE_LEAD_IN_PX = 48;

// Unlike useCodeViewFileReveal, a reveal waits until its file is in `readyFileKeys` (unfolded)
// and is dropped once `scope` changes.
export function useScopedCodeViewFileReveal<TScope>(
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

  // oxlint-disable-next-line t3code/react-effect-budget -- scrolls the external viewer once the file is ready
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

  return (fileKey: string, range?: SelectedLineRange) => setRequest({ fileKey, range, scope });
}
