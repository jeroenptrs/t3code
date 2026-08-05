import type {
  OrchestrationThreadShell,
  ScheduledAutomation,
  ScheduledAutomationOutcome,
  ScheduledAutomationVisibleStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveScheduledAutomationVisibleStatus } from "./ScheduledAutomationService.ts";

const NOW = "2026-08-05T12:00:00.000Z";
const SCHEDULED_FOR = "2026-08-05T11:00:00.000Z";

const outcome = (kind: ScheduledAutomationOutcome["kind"]): ScheduledAutomationOutcome => {
  const common = { scheduledFor: SCHEDULED_FOR, observedAt: SCHEDULED_FOR, coalescedCount: 0 };
  if (kind === "failed") {
    return {
      ...common,
      kind,
      code: "provider.failed",
      detail: "Provider failed.",
      retryable: true,
    };
  }
  if (kind === "skipped-active") {
    return { ...common, kind, previousThreadId: "previous-thread" } as ScheduledAutomationOutcome;
  }
  return { ...common, kind } as ScheduledAutomationOutcome;
};

const automation = (lastOutcome: ScheduledAutomationOutcome | null): ScheduledAutomation =>
  ({ lastOutcome }) as ScheduledAutomation;

const shell = (input: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell =>
  ({
    latestTurn: null,
    latestUserMessageAt: null,
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    settledOverride: null,
    settledAt: null,
    ...input,
  }) as OrchestrationThreadShell;

describe("scheduled automation operator status truth", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly row: ScheduledAutomation;
    readonly thread: OrchestrationThreadShell | null;
    readonly expected: ScheduledAutomationVisibleStatus;
  }> = [
    { name: "never run", row: automation(null), thread: null, expected: "never-run" },
    {
      name: "starting",
      row: automation(outcome("starting")),
      thread: shell(),
      expected: "starting",
    },
    {
      name: "running",
      row: automation(outcome("started")),
      thread: shell({ latestTurn: { state: "running" } as OrchestrationThreadShell["latestTurn"] }),
      expected: "running",
    },
    {
      name: "blocked",
      row: automation(outcome("started")),
      thread: shell({ hasPendingApprovals: true }),
      expected: "blocked",
    },
    {
      name: "completed",
      row: automation(outcome("started")),
      thread: shell({
        latestTurn: { state: "completed" } as OrchestrationThreadShell["latestTurn"],
        settledOverride: "active",
      }),
      expected: "completed",
    },
    {
      name: "thread failure",
      row: automation(outcome("started")),
      thread: shell({ latestTurn: { state: "error" } as OrchestrationThreadShell["latestTurn"] }),
      expected: "failed",
    },
    {
      name: "interrupted",
      row: automation(outcome("started")),
      thread: shell({
        latestTurn: { state: "interrupted" } as OrchestrationThreadShell["latestTurn"],
      }),
      expected: "interrupted",
    },
    {
      name: "durably failed outcome",
      row: automation(outcome("failed")),
      thread: shell({
        latestTurn: { state: "completed" } as OrchestrationThreadShell["latestTurn"],
      }),
      expected: "failed",
    },
    {
      name: "durably skipped outcome",
      row: automation(outcome("skipped-active")),
      thread: shell({
        latestTurn: { state: "completed" } as OrchestrationThreadShell["latestTurn"],
      }),
      expected: "skipped-active",
    },
    {
      name: "missing current occurrence thread",
      row: automation(outcome("started")),
      thread: null,
      expected: "thread-missing",
    },
  ];

  for (const fixture of cases) {
    it(fixture.name, () => {
      expect(deriveScheduledAutomationVisibleStatus(fixture.row, fixture.thread, NOW)).toBe(
        fixture.expected,
      );
    });
  }

  it("does not consult settlement for running or completed truth", () => {
    const running = shell({
      latestTurn: { state: "running" } as OrchestrationThreadShell["latestTurn"],
      settledOverride: "settled",
      settledAt: NOW,
    });
    const completed = shell({
      latestTurn: { state: "completed" } as OrchestrationThreadShell["latestTurn"],
      settledOverride: "active",
    });

    expect(
      deriveScheduledAutomationVisibleStatus(automation(outcome("started")), running, NOW),
    ).toBe("running");
    expect(
      deriveScheduledAutomationVisibleStatus(automation(outcome("started")), completed, NOW),
    ).toBe("completed");
  });
});
