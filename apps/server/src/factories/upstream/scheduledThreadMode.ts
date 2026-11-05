// Adapts upstream pingdotgg/t3code#30326 (scheduled tasks run in one thread).
import type { ScheduledTaskThreadMode, ScheduledTaskUpsertInput } from "@t3tools/contracts";

export { ScheduledTaskThreadMode, scheduledTaskThreadMode } from "@t3tools/contracts";

export const FRESH_SESSION_THREAD_MODE = "fresh_session" satisfies ScheduledTaskThreadMode;

export type ScheduledTaskUpsertWithThreadMode = ScheduledTaskUpsertInput & {
  readonly threadMode: ScheduledTaskThreadMode;
};
