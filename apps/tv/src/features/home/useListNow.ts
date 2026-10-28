import { useEffect, useState } from "react";

const MINUTE_MS = 60_000;

/**
 * The list's clock as an ISO timestamp: it advances each wall-clock minute and when the next
 * snooze expires, so relative times and the Snoozed shelf move on time without a ticking render.
 */
export function useListNow(threads: ReadonlyArray<{ readonly snoozedUntil: string | null }>) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  let nextWakeMs = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (const thread of threads) {
    const wakeMs = Date.parse(thread.snoozedUntil ?? "");
    if (wakeMs > nowMs && wakeMs < nextWakeMs) nextWakeMs = wakeMs;
  }
  useEffect(() => {
    const timer = setTimeout(() => setNowMs(Date.now()), Math.max(0, nextWakeMs - Date.now()));
    return () => clearTimeout(timer);
  }, [nextWakeMs]);
  return new Date(nowMs).toISOString();
}
