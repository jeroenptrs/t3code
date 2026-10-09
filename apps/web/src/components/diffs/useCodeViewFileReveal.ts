import type { CodeViewScrollTarget, SelectedLineRange } from "@pierre/diffs";
import { useEffect, useRef, useState } from "react";

interface FileRevealHandle {
  getInstance(): object | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

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

  return (fileKey: string, range?: SelectedLineRange) => setRequest({ fileKey, range, scope });
}
