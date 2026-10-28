import type { ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";

let devThreadOpened = false;

/**
 * Dev-only: EXPO_PUBLIC_TV_DEV_OPEN_THREAD=<threadId|first> opens that thread, or the newest
 * visible one, the first time the environment screen lists it, for a simulator nothing presses
 * remote buttons on. Fires once per launch so Menu can still return to the environment.
 */
export function useDevOpenThread(
  threadIds: ReadonlyArray<ThreadId>,
  open: (threadId: ThreadId) => void,
): void {
  const target = __DEV__ ? process.env.EXPO_PUBLIC_TV_DEV_OPEN_THREAD : undefined;
  useEffect(() => {
    if (devThreadOpened || !target) return;
    const threadId = target === "first" ? threadIds[0] : threadIds.find((id) => id === target);
    if (threadId === undefined) return;
    devThreadOpened = true;
    open(threadId);
  }, [open, target, threadIds]);
}

let devMessageSent = false;

/**
 * Dev-only: EXPO_PUBLIC_TV_DEV_SEND_MESSAGE=<text> sends that text through the reply path once
 * per launch, as soon as the opened thread can take a message, to exercise send and streaming
 * without a remote.
 */
export function useDevSendMessage(ready: boolean, send: (text: string) => Promise<boolean>) {
  const text = __DEV__ ? process.env.EXPO_PUBLIC_TV_DEV_SEND_MESSAGE : undefined;
  useEffect(() => {
    if (devMessageSent || !ready || !text) return;
    devMessageSent = true;
    void send(text);
  }, [ready, send, text]);
}

export type ThreadSheetKind = "thread" | "git" | "terminal" | "agents";

let devSheetOpened = false;

/**
 * Dev-only: EXPO_PUBLIC_TV_DEV_OPEN_SHEET=thread|git|terminal|agents opens that thread header sheet once
 * per launch, as soon as the opened thread has loaded, to see a sheet without a remote.
 */
export function useDevOpenSheet(ready: boolean, open: (sheet: ThreadSheetKind) => void) {
  const sheet = __DEV__ ? process.env.EXPO_PUBLIC_TV_DEV_OPEN_SHEET : undefined;
  useEffect(() => {
    if (devSheetOpened || !ready) return;
    if (sheet !== "thread" && sheet !== "git" && sheet !== "terminal" && sheet !== "agents") {
      return;
    }
    devSheetOpened = true;
    open(sheet);
  }, [open, ready, sheet]);
}

let devNewThreadOpened = false;

/**
 * Dev-only: EXPO_PUBLIC_TV_DEV_OPEN_NEW_THREAD=1 opens the new-thread composer once per launch.
 * With EXPO_PUBLIC_TV_DEV_SEND_MESSAGE it starts the thread with that text as soon as it can.
 */
export function useDevOpenNewThread(open: () => void) {
  const enabled = __DEV__ && process.env.EXPO_PUBLIC_TV_DEV_OPEN_NEW_THREAD === "1";
  useEffect(() => {
    if (devNewThreadOpened || !enabled) return;
    devNewThreadOpened = true;
    open();
  }, [enabled, open]);
}
