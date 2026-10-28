import {
  EMPTY_TERMINAL_BUFFER_STATE,
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
  type TerminalBufferState,
} from "@t3tools/client-runtime/state/terminal";
import * as Option from "effect/Option";
import { AsyncResult, type Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { tvAtomRegistry } from "../../state/atom-registry";
import { createAnsiParser, type AnsiLine } from "./ansi";

/** About 15 renders a second however fast the shell writes. */
const FLUSH_INTERVAL_MS = 66;

export interface TerminalLinesState {
  readonly lines: ReadonlyArray<AnsiLine>;
  readonly status: TerminalBufferState["status"] | "error";
  readonly error: string | null;
}

const EMPTY_STATE: TerminalLinesState = { lines: [], status: "closed", error: null };

/**
 * Follows a terminal's attach or observe atom, parses each output update as it lands, and
 * publishes the parsed lines on a timer, so a burst of chunks costs one render.
 */
export function useTerminalLines(
  atom: Atom.Atom<AsyncResult.AsyncResult<TerminalBufferState, unknown>> | null,
): TerminalLinesState {
  const [state, setState] = useState(EMPTY_STATE);
  useEffect(() => {
    if (atom === null) return;
    const parser = createAnsiParser();
    let cursor = INITIAL_TERMINAL_OUTPUT_CURSOR;
    let status: TerminalLinesState["status"] = "closed";
    let error: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastFlush = 0;
    const flush = () => {
      timer = null;
      lastFlush = Date.now();
      setState({ lines: parser.lines(), status, error });
    };
    const unsubscribe = tvAtomRegistry.subscribe(
      atom,
      (result) => {
        const buffer = Option.getOrElse(
          AsyncResult.value(result),
          () => EMPTY_TERMINAL_BUFFER_STATE,
        );
        status = result._tag === "Failure" ? "error" : buffer.status;
        error = result._tag === "Failure" ? "The terminal could not be reached." : buffer.error;
        const update = readTerminalOutputUpdate(buffer.output, cursor);
        cursor = update.cursor;
        if (update.type === "reset") {
          parser.reset();
          parser.write(update.data);
        } else if (update.type === "append") {
          parser.write(update.data);
        }
        timer ??= setTimeout(flush, Math.max(0, FLUSH_INTERVAL_MS - (Date.now() - lastFlush)));
      },
      { immediate: true },
    );
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [atom]);
  return state;
}
