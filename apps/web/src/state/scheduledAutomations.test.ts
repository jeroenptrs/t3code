import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ScheduledAutomationId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  INITIAL_SCHEDULED_AUTOMATION_HEALTH,
  applyScheduledAutomationStateStreamItem,
  applyScheduledAutomationStreamItem,
  projectScheduledAutomationStream,
} from "./scheduledAutomations";

function view(id: string, name: string, createdAt = "2026-08-04T12:00:00.000Z") {
  return {
    automation: {
      id: ScheduledAutomationId.make(id),
      revision: 1,
      name,
      prompt: "Prompt",
      projectId: ProjectId.make("project"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
      },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      worktreePolicy: { kind: "current" as const },
      setupScriptPolicy: "skip" as const,
      schedule: {
        cron: "0 9 * * *",
        timeZone: "UTC",
        misfirePolicy: "latest-only" as const,
      },
      enabled: false,
      enabledAt: null,
      lastScheduledFor: null,
      lastThreadId: null,
      lastOutcome: null,
      createdAt,
      updatedAt: "2026-08-04T12:00:00.000Z",
    },
    status: "never-run" as const,
    nextScheduledFor: null,
    lastThread: null,
  };
}

describe("scheduled automation subscription projection", () => {
  it("reconstructs snapshots and applies committed upserts/removals", () => {
    const alpha = view("alpha", "Zulu", "2026-08-04T12:00:00.000Z");
    const beta = view("beta", "Alpha", "2026-08-05T12:00:00.000Z");
    const snapshot = applyScheduledAutomationStreamItem([], {
      kind: "snapshot",
      automations: [beta],
      health: INITIAL_SCHEDULED_AUTOMATION_HEALTH,
    });
    const upserted = applyScheduledAutomationStreamItem(snapshot, {
      kind: "upserted",
      automation: alpha,
    });
    expect(upserted.map((item) => item.automation.id)).toEqual(["alpha", "beta"]);
    expect(
      applyScheduledAutomationStreamItem(upserted, {
        kind: "removed",
        automationId: beta.automation.id,
      }),
    ).toEqual([alpha]);
  });

  it.effect("does not emit an empty seed before the first server snapshot", () => {
    const alpha = view("alpha", "Alpha");
    return projectScheduledAutomationStream(
      Stream.fromIterable([
        {
          kind: "snapshot" as const,
          automations: [alpha],
          health: INITIAL_SCHEDULED_AUTOMATION_HEALTH,
        },
      ]),
    ).pipe(
      Stream.runCollect,
      Effect.map((values) => {
        expect(Array.from(values)).toEqual([[alpha]]);
      }),
    );
  });

  it("projects scheduler and malformed-definition health without rewriting rows", () => {
    const alpha = view("alpha", "Alpha");
    const initial = applyScheduledAutomationStateStreamItem(
      { views: [], health: INITIAL_SCHEDULED_AUTOMATION_HEALTH },
      {
        kind: "snapshot",
        automations: [alpha],
        health: INITIAL_SCHEDULED_AUTOMATION_HEALTH,
      },
    );
    const degraded = applyScheduledAutomationStateStreamItem(initial, {
      kind: "snapshot",
      automations: [alpha],
      health: { status: "degraded", schedulerStatus: "failed", malformedDefinitionCount: 1 },
    });

    expect(degraded.views).toEqual([alpha]);
    expect(degraded.health).toEqual({
      status: "degraded",
      schedulerStatus: "failed",
      malformedDefinitionCount: 1,
    });
  });
});
