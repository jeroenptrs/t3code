import type { CodeViewHandle } from "@pierre/diffs/react";
import { useEffect, useState } from "react";

import {
  activeDiffWalkthroughEntryKey,
  lastIndexAtOrAbove,
  type DiffWalkthroughRailNote,
} from "./diffWalkthroughRail.logic";

/** How far below the top of the viewer the reader is taken to be reading. */
const READING_LINE_PX = 96;

/**
 * The walkthrough entry under the reader's eye. Measured from the viewer's own scroll signal at
 * most once a frame, and only stored when the entry changes, so scrolling re-renders the rail
 * only as the reader crosses from one entry into the next.
 *
 * `files` is the diff's files in the order the viewer shows them; pass `notesByPath` as null to
 * stop following while the rail is closed.
 */
export function useDiffWalkthroughActiveEntry<TAnnotation>(
  viewer: CodeViewHandle<TAnnotation, undefined> | null,
  files: ReadonlyArray<{ readonly id: string; readonly path: string }>,
  notesByPath: ReadonlyMap<string, ReadonlyArray<DiffWalkthroughRailNote>> | null,
): string | null {
  const [activeKey, setActiveKey] = useState<string | null>(null);

  useEffect(() => {
    const instance = viewer?.getInstance();
    if (instance === undefined || notesByPath === null || files.length === 0) return;
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const probe = instance.getScrollTop() + Math.min(READING_LINE_PX, instance.getHeight() / 4);
      const index = lastIndexAtOrAbove(
        files.length,
        (position) => instance.getTopForItem(files[position]!.id),
        probe,
      );
      const file = files[Math.max(index, 0)]!;
      const itemTop = instance.getTopForItem(file.id);
      const rendered = instance.getRenderedItems().find((item) => item.id === file.id);
      setActiveKey(
        activeDiffWalkthroughEntryKey(notesByPath, {
          path: file.path,
          probe,
          noteTop: (note) => {
            // A folded file puts every line on its header, which would read as the last note.
            if (itemTop === undefined || rendered?.type !== "diff" || rendered.item.collapsed) {
              return undefined;
            }
            const position = rendered.instance.getLinePosition(note.startLine, note.side);
            return position === undefined ? undefined : itemTop + position.top;
          },
        }),
      );
    };
    const unsubscribe = instance.subscribeToScroll(() => {
      frame ??= requestAnimationFrame(measure);
    });
    measure();
    return () => {
      unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [files, notesByPath, viewer]);

  return notesByPath === null ? null : activeKey;
}
