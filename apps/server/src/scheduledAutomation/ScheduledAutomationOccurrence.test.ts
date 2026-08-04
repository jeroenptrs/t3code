import {
  latestScheduledAutomationOccurrence,
  nextScheduledAutomationOccurrence,
  scheduledAutomationPlanningBoundary,
  ScheduledAutomationId,
  ScheduledAutomationOutcome,
  ScheduledAutomationSchedule,
  type OrchestrationLatestTurnState,
  type OrchestrationSessionStatus,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  deriveScheduledAutomationOccurrenceIdentity,
  isScheduledAutomationThreadActive,
  type ScheduledAutomationActivityShell,
} from "./ScheduledAutomationOccurrence.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledAutomationSchedule);
const decodeAutomationId = Schema.decodeUnknownSync(ScheduledAutomationId);
const decodeOutcome = Schema.decodeUnknownSync(ScheduledAutomationOutcome);

function schedule(cron: string, timeZone: string) {
  return decodeSchedule({ cron, timeZone, misfirePolicy: "latest-only" });
}

function success<A, E>(result: Result.Result<A, E>): A {
  assert.isTrue(Result.isSuccess(result));
  if (Result.isFailure(result)) throw new Error("Expected Result.Success");
  return result.success;
}

it.effect("snapshot-locks deterministic occurrence identities and ownership paths", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const automationId = ScheduledAutomationId.make("nightly-maintenance");
    const input = {
      automationId,
      scheduledFor: "2026-08-03T09:30:00.000Z",
      worktreesDir: "/tmp/t3-worktrees",
    } as const;
    const first = success(deriveScheduledAutomationOccurrenceIdentity(input, path));
    const second = success(deriveScheduledAutomationOccurrenceIdentity(input, path));

    expect(first).toMatchInlineSnapshot(`
    {
      "automationKey": "6e696768746c792d6d61696e74656e616e6365",
      "bootstrapCommandId": "t3sa:v1:6e696768746c792d6d61696e74656e616e6365:323032362d30382d30335430393a33303a30302e3030305a:command:bootstrap",
      "branch": "t3/local-scheduled-automation/6e696768746c792d6d61696e74656e616e6365/323032362d30382d30335430393a33303a30302e3030305a",
      "failureActivityId": "t3sa:v1:6e696768746c792d6d61696e74656e616e6365:323032362d30382d30335430393a33303a30302e3030305a:command:bootstrap:activity:failed",
      "messageId": "t3sa:v1:6e696768746c792d6d61696e74656e616e6365:323032362d30382d30335430393a33303a30302e3030305a:message:initial",
      "occurrenceKey": "323032362d30382d30335430393a33303a30302e3030305a",
      "phaseCommandIds": {
        "createThread": "t3sa:v1:6e696768746c792d6d61696e74656e616e6365:323032362d30382d30335430393a33303a30302e3030305a:command:bootstrap:phase:create-thread",
        "prepareWorktree": "t3sa:v1:6e696768746c792d6d61696e74656e616e6365:323032362d30382d30335430393a33303a30302e3030305a:command:bootstrap:phase:prepare-worktree",
        "recordFailure": "t3sa:v1:6e696768746c792d6d61696e74656e616e6365:323032362d30382d30335430393a33303a30302e3030305a:command:bootstrap:phase:record-failure",
        "startTurn": "t3sa:v1:6e696768746c792d6d61696e74656e616e6365:323032362d30382d30335430393a33303a30302e3030305a:command:bootstrap:phase:start-turn",
        "updateThreadMetadata": "t3sa:v1:6e696768746c792d6d61696e74656e616e6365:323032362d30382d30335430393a33303a30302e3030305a:command:bootstrap:phase:update-thread-metadata",
      },
      "threadId": "t3sa:v1:6e696768746c792d6d61696e74656e616e6365:323032362d30382d30335430393a33303a30302e3030305a:thread",
      "worktreePath": "/tmp/t3-worktrees/local-scheduled-automations-v1/6e696768746c792d6d61696e74656e616e6365/323032362d30382d30335430393a33303a30302e3030305a",
    }
  `);
    assert.deepStrictEqual(second, first);

    const later = success(
      deriveScheduledAutomationOccurrenceIdentity(
        {
          ...input,
          scheduledFor: "2026-08-04T09:30:00.000Z",
        },
        path,
      ),
    );
    assert.notStrictEqual(later.threadId, first.threadId);
    assert.notStrictEqual(later.messageId, first.messageId);
    assert.notStrictEqual(later.bootstrapCommandId, first.bootstrapCommandId);
    for (const phase of Object.keys(first.phaseCommandIds) as ReadonlyArray<
      keyof typeof first.phaseCommandIds
    >) {
      assert.notStrictEqual(
        later.phaseCommandIds[phase],
        first.phaseCommandIds[phase],
        `phase command id must differ for ${phase}`,
      );
    }
    assert.notStrictEqual(later.failureActivityId, first.failureActivityId);
    assert.notStrictEqual(later.branch, first.branch);
    assert.notStrictEqual(later.worktreePath, first.worktreePath);

    const otherAutomation = success(
      deriveScheduledAutomationOccurrenceIdentity(
        { ...input, automationId: ScheduledAutomationId.make("weekly-maintenance") },
        path,
      ),
    );
    assert.notStrictEqual(otherAutomation.threadId, first.threadId);

    const equivalentInstant = success(
      deriveScheduledAutomationOccurrenceIdentity(
        { ...input, scheduledFor: "2026-08-03T09:30:00Z" },
        path,
      ),
    );
    assert.deepStrictEqual(equivalentInstant, first);

    const invalidInstant = deriveScheduledAutomationOccurrenceIdentity(
      { ...input, scheduledFor: "not-an-instant" },
      path,
    );
    assert.isTrue(Result.isFailure(invalidInstant));
    const localDateTime = deriveScheduledAutomationOccurrenceIdentity(
      { ...input, scheduledFor: "2026-08-03T09:30:00" },
      path,
    );
    assert.isTrue(Result.isFailure(localDateTime));

    // Prompt/model data cannot enter derivation: the input type excludes it,
    // and the locked snapshot contains only tuple-derived namespace values.
  }).pipe(Effect.provide(Path.layer)),
);

it.effect("keeps every accepted automation id within Git and filesystem component limits", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const automationId = decodeAutomationId(`a${"z".repeat(63)}`);
    const identity = success(
      deriveScheduledAutomationOccurrenceIdentity(
        {
          automationId,
          scheduledFor: "2026-08-03T09:30:00.000Z",
          worktreesDir: "/tmp/t3-worktrees",
        },
        path,
      ),
    );
    const byteLength = (value: string) => new TextEncoder().encode(value).length;
    assert.isAtMost(byteLength(path.basename(identity.worktreePath)), 255);
    for (const component of identity.branch.split("/")) {
      assert.isAtMost(byteLength(component), 255);
    }
    assert.isAtMost(byteLength(identity.branch), 1_024);
    assert.throws(() => decodeAutomationId("é".repeat(64)));
    assert.throws(() => decodeAutomationId(`a${"z".repeat(64)}`));
  }).pipe(Effect.provide(Path.layer)),
);

it.effect("keeps distinct ownership keys distinct after filesystem case folding", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const scheduledFor = "2026-08-03T09:30:00.000Z";
    const worktreesDir = "/tmp/t3-worktrees";
    const lower = success(
      deriveScheduledAutomationOccurrenceIdentity(
        { automationId: decodeAutomationId("aaa"), scheduledFor, worktreesDir },
        path,
      ),
    );
    const mixed = success(
      deriveScheduledAutomationOccurrenceIdentity(
        { automationId: decodeAutomationId("aaG"), scheduledFor, worktreesDir },
        path,
      ),
    );

    assert.notStrictEqual(lower.automationKey.toLowerCase(), mixed.automationKey.toLowerCase());
    assert.notStrictEqual(lower.branch.toLowerCase(), mixed.branch.toLowerCase());
    assert.notStrictEqual(lower.worktreePath.toLowerCase(), mixed.worktreePath.toLowerCase());
  }).pipe(Effect.provide(Path.layer)),
);

it("plans UTC and non-UTC occurrences", () => {
  assert.strictEqual(
    success(
      nextScheduledAutomationOccurrence(schedule("0 * * * *", "UTC"), "2026-08-03T09:15:00Z"),
    ),
    "2026-08-03T10:00:00.000Z",
  );
  assert.strictEqual(
    success(
      nextScheduledAutomationOccurrence(
        schedule("0 9 * * *", "America/New_York"),
        "2026-01-01T13:59:00Z",
      ),
    ),
    "2026-01-01T14:00:00.000Z",
  );
});

it("uses Effect Cron truth across daylight-saving gaps and repeated hours", () => {
  const amsterdam = schedule("30 2 * * *", "Europe/Amsterdam");
  assert.strictEqual(
    success(nextScheduledAutomationOccurrence(amsterdam, "2026-03-28T01:30:00.000Z")),
    "2026-03-29T01:30:00.000Z",
  );
  assert.strictEqual(
    success(nextScheduledAutomationOccurrence(amsterdam, "2026-10-24T00:30:00.000Z")),
    "2026-10-25T00:30:00.000Z",
  );
  assert.strictEqual(
    success(nextScheduledAutomationOccurrence(amsterdam, "2026-10-25T00:30:00.000Z")),
    "2026-10-26T01:30:00.000Z",
  );
});

function latestOccurrence(
  cronSchedule: ReturnType<typeof schedule>,
  input: Parameters<typeof latestScheduledAutomationOccurrence>[1],
): string | null {
  return Option.getOrNull(success(latestScheduledAutomationOccurrence(cronSchedule, input)));
}

it("keeps latest-only consistent with the forward Cron sequence across DST", () => {
  const amsterdam = schedule("30 2 * * *", "Europe/Amsterdam");
  const enabledAt = "2026-01-01T00:00:00.000Z";

  assert.strictEqual(
    latestOccurrence(amsterdam, {
      enabledAt,
      lastScheduledFor: null,
      now: "2026-03-29T01:29:59.999Z",
    }),
    "2026-03-28T01:30:00.000Z",
  );
  assert.strictEqual(
    latestOccurrence(amsterdam, {
      enabledAt,
      lastScheduledFor: null,
      now: "2026-03-29T01:30:00.000Z",
    }),
    "2026-03-29T01:30:00.000Z",
  );
  assert.strictEqual(
    latestOccurrence(amsterdam, {
      enabledAt,
      lastScheduledFor: "2026-03-29T01:30:00.000Z",
      now: "2026-03-29T03:00:00.000Z",
    }),
    null,
  );

  assert.strictEqual(
    latestOccurrence(amsterdam, {
      enabledAt,
      lastScheduledFor: null,
      now: "2026-10-25T00:29:59.999Z",
    }),
    "2026-10-24T00:30:00.000Z",
  );
  for (const now of [
    "2026-10-25T00:30:00.000Z",
    "2026-10-25T01:29:59.999Z",
    "2026-10-25T01:30:00.000Z",
    "2026-10-25T01:30:01.000Z",
  ]) {
    assert.strictEqual(
      latestOccurrence(amsterdam, { enabledAt, lastScheduledFor: null, now }),
      "2026-10-25T00:30:00.000Z",
      now,
    );
    assert.strictEqual(
      latestOccurrence(amsterdam, {
        enabledAt,
        lastScheduledFor: "2026-10-25T00:30:00.000Z",
        now,
      }),
      null,
      `cursor ${now}`,
    );
  }
});

it("returns typed failures for impossible calendar schedules", () => {
  const impossible = {
    cron: "0 0 31 2 *",
    timeZone: "UTC",
    misfirePolicy: "latest-only",
  } as ReturnType<typeof schedule>;
  const next = nextScheduledAutomationOccurrence(impossible, "2026-01-01T00:00:00.000Z");
  assert.isTrue(Result.isFailure(next));
  if (Result.isFailure(next)) assert.strictEqual(next.failure.field, "schedule.cron");

  const latest = latestScheduledAutomationOccurrence(impossible, {
    enabledAt: "2026-01-01T00:00:00.000Z",
    lastScheduledFor: null,
    now: "2026-08-03T00:00:00.000Z",
  });
  assert.isTrue(Result.isFailure(latest));
  if (Result.isFailure(latest)) assert.strictEqual(latest.failure.field, "schedule.cron");
});

it("coalesces multiple missed occurrences to the latest eligible instant", () => {
  const latest = success(
    latestScheduledAutomationOccurrence(schedule("0 * * * *", "UTC"), {
      enabledAt: "2026-08-03T00:10:00.000Z",
      lastScheduledFor: "2026-08-03T01:00:00.000Z",
      now: "2026-08-03T05:45:00.000Z",
    }),
  );
  assert.strictEqual(Option.getOrNull(latest), "2026-08-03T05:00:00.000Z");

  const noReplayAtBoundary = success(
    latestScheduledAutomationOccurrence(schedule("0 * * * *", "UTC"), {
      enabledAt: "2026-08-03T05:00:00.000Z",
      lastScheduledFor: null,
      now: "2026-08-03T05:30:00.000Z",
    }),
  );
  assert.isTrue(Option.isNone(noReplayAtBoundary));
});

it("excludes the disabled interval after reactivation from planning and coalescing", () => {
  assert.strictEqual(
    success(
      scheduledAutomationPlanningBoundary({
        enabledAt: "2026-08-03T10:15:00.000Z",
        lastScheduledFor: "2026-08-01T02:30:00.000Z",
      }),
    ),
    "2026-08-03T10:15:00.000Z",
  );
  assert.isTrue(
    Option.isNone(
      success(
        latestScheduledAutomationOccurrence(schedule("30 2 * * *", "UTC"), {
          enabledAt: "2026-08-03T10:15:00.000Z",
          lastScheduledFor: "2026-08-01T02:30:00.000Z",
          now: "2026-08-03T23:59:59.999Z",
        }),
      ),
    ),
  );
  assert.strictEqual(
    Option.getOrNull(
      success(
        latestScheduledAutomationOccurrence(schedule("30 2 * * *", "UTC"), {
          enabledAt: "2026-08-03T10:15:00.000Z",
          lastScheduledFor: "2026-08-01T02:30:00.000Z",
          now: "2026-08-04T03:00:00.000Z",
        }),
      ),
    ),
    "2026-08-04T02:30:00.000Z",
  );
});

it("decodes invariant-sensitive legacy failures as non-retryable", () => {
  for (const code of ["bootstrap.phase-rejected", "occurrence.abandoned"]) {
    const decoded = decodeOutcome({
      kind: "failed",
      scheduledFor: "2026-08-04T02:30:00.000Z",
      observedAt: "2026-08-04T02:31:00.000Z",
      coalescedCount: 0,
      code,
      detail: "Legacy failure without retryability.",
    });
    assert.isTrue(decoded.kind === "failed");
    if (decoded.kind === "failed") assert.isFalse(decoded.retryable);
  }
});

const NOW = "2026-08-03T10:00:00.000Z";
const baseShell: ScheduledAutomationActivityShell = {
  session: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  latestUserMessageAt: null,
  latestTurn: null,
};

it("treats only starting and running sessions as active", () => {
  const expectations = {
    idle: false,
    starting: true,
    running: true,
    ready: false,
    interrupted: false,
    stopped: false,
    error: false,
  } satisfies Record<OrchestrationSessionStatus, boolean>;
  for (const [status, expected] of Object.entries(expectations) as ReadonlyArray<
    readonly [OrchestrationSessionStatus, boolean]
  >) {
    const shell = {
      ...baseShell,
      session: { status } as NonNullable<OrchestrationThreadShell["session"]>,
    };
    assert.strictEqual(isScheduledAutomationThreadActive(shell, { now: NOW }), expected, status);
  }
});

it("uses live turn and user-blocking truth without settlement", () => {
  const turnExpectations = {
    running: true,
    interrupted: false,
    completed: false,
    error: false,
  } satisfies Record<OrchestrationLatestTurnState, boolean>;
  for (const [state, expected] of Object.entries(turnExpectations) as ReadonlyArray<
    readonly [OrchestrationLatestTurnState, boolean]
  >) {
    const shell = {
      ...baseShell,
      latestTurn: { state } as NonNullable<OrchestrationThreadShell["latestTurn"]>,
    };
    assert.strictEqual(isScheduledAutomationThreadActive(shell, { now: NOW }), expected, state);
  }

  assert.isTrue(
    isScheduledAutomationThreadActive({ ...baseShell, hasPendingApprovals: true }, { now: NOW }),
  );
  assert.isTrue(
    isScheduledAutomationThreadActive({ ...baseShell, hasPendingUserInput: true }, { now: NOW }),
  );
  assert.isFalse(isScheduledAutomationThreadActive(null, { now: NOW }));

  const settledCompleted = {
    ...baseShell,
    settledOverride: "settled",
    settledAt: "2026-08-03T09:59:00.000Z",
    latestTurn: { state: "completed" } as NonNullable<OrchestrationThreadShell["latestTurn"]>,
  };
  const unsettledCompleted = {
    ...baseShell,
    settledOverride: null,
    settledAt: null,
    latestTurn: { state: "completed" } as NonNullable<OrchestrationThreadShell["latestTurn"]>,
  };
  assert.isFalse(isScheduledAutomationThreadActive(settledCompleted, { now: NOW }));
  assert.isFalse(isScheduledAutomationThreadActive(unsettledCompleted, { now: NOW }));
});

it("shares the bounded queued-turn-start truth", () => {
  assert.isTrue(
    isScheduledAutomationThreadActive(
      { ...baseShell, latestUserMessageAt: "2026-08-03T09:59:00.000Z" },
      { now: NOW },
    ),
  );
  assert.isFalse(
    isScheduledAutomationThreadActive(
      { ...baseShell, latestUserMessageAt: "2026-08-03T09:57:59.000Z" },
      { now: NOW },
    ),
  );
});
