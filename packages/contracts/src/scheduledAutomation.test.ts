import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  ScheduledAutomationCommand,
  ScheduledAutomationDefinition,
  ScheduledAutomationListResult,
  ScheduledAutomationStreamItem,
  validateScheduledAutomationDefinitionDraft,
} from "./scheduledAutomation.ts";
import type { ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";

const decodeDefinition = Schema.decodeUnknownEffect(ScheduledAutomationDefinition);
const decodeCommand = Schema.decodeUnknownEffect(ScheduledAutomationCommand);
const decodeListResult = Schema.decodeUnknownSync(ScheduledAutomationListResult);
const decodeStreamItem = Schema.decodeUnknownSync(ScheduledAutomationStreamItem);

const runtimeModes = {
  "approval-required": true,
  "auto-accept-edits": true,
  auto: true,
  "full-access": true,
} satisfies Record<RuntimeMode, true>;
const interactionModes = {
  default: true,
  plan: true,
} satisfies Record<ProviderInteractionMode, true>;

function definition(overrides: Record<string, unknown> = {}) {
  return {
    name: "Nightly maintenance",
    prompt: "Inspect the workspace and fix the highest-priority issue.",
    projectId: "project-1",
    modelSelection: {
      instanceId: "codex-work",
      model: "gpt-5.6",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePolicy: {
      kind: "new-worktree",
      baseBranch: "main",
      startFromOrigin: true,
    },
    setupScriptPolicy: "skip",
    schedule: {
      cron: "30 2 * * 1-5",
      timeZone: "Europe/Amsterdam",
      misfirePolicy: "latest-only",
    },
    ...overrides,
  };
}

it.effect("accepts every runtime and interaction mode and preserves ragged model options", () =>
  Effect.gen(function* () {
    for (const runtimeMode of Object.keys(runtimeModes) as ReadonlyArray<RuntimeMode>) {
      for (const interactionMode of Object.keys(
        interactionModes,
      ) as ReadonlyArray<ProviderInteractionMode>) {
        const parsed = yield* decodeDefinition(definition({ runtimeMode, interactionMode }));
        assert.strictEqual(parsed.runtimeMode, runtimeMode);
        assert.strictEqual(parsed.interactionMode, interactionMode);
        assert.deepStrictEqual(parsed.modelSelection.options, [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ]);
      }
    }
  }),
);

it.effect("represents the explicitly shared current-workspace policy", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeDefinition(definition({ worktreePolicy: { kind: "current" } }));
    assert.deepStrictEqual(parsed.worktreePolicy, { kind: "current" });
  }),
);

it.effect("rejects invalid definition boundaries", () =>
  Effect.gen(function* () {
    const invalidDefinitions = [
      definition({ name: "   " }),
      definition({ prompt: "   " }),
      definition({
        schedule: { cron: "not a cron", timeZone: "UTC", misfirePolicy: "latest-only" },
      }),
      definition({
        schedule: { cron: "0 0 0 * * *", timeZone: "UTC", misfirePolicy: "latest-only" },
      }),
      definition({
        schedule: { cron: "0 0 31 2 *", timeZone: "UTC", misfirePolicy: "latest-only" },
      }),
      definition({
        schedule: { cron: "0 9 * * *", timeZone: "Mars/Olympus", misfirePolicy: "latest-only" },
      }),
      definition({
        schedule: { cron: "0 9 * * *", timeZone: "+02:00", misfirePolicy: "latest-only" },
      }),
      definition({ setupScriptPolicy: "run-once" }),
    ];

    for (const [index, input] of invalidDefinitions.entries()) {
      const result = yield* Effect.exit(decodeDefinition(input));
      assert.strictEqual(result._tag, "Failure", `invalid definition fixture ${index}`);
    }
  }),
);

it.effect("lets invalid schedule drafts reach field-addressed server validation", () =>
  Effect.gen(function* () {
    for (const [scheduleOverride, expectedField] of [
      [{ cron: "61 * * * *" }, "schedule.cron"],
      [{ cron: "0 0 31 2 *" }, "schedule.cron"],
      [{ timeZone: "Mars/Olympus" }, "schedule.timeZone"],
    ] as const) {
      const input = definition({
        schedule: {
          cron: "0 9 * * *",
          timeZone: "UTC",
          misfirePolicy: "latest-only",
          ...scheduleOverride,
        },
      });
      const command = yield* decodeCommand({
        type: "scheduledAutomation.create",
        commandId: `command-${expectedField}-${scheduleOverride.cron ?? scheduleOverride.timeZone}`,
        automationId: "automation-1",
        definition: input,
        createdAt: "2026-08-03T09:00:00.000Z",
      });
      assert.strictEqual(command.type, "scheduledAutomation.create");
      if (command.type !== "scheduledAutomation.create") continue;

      const validated = validateScheduledAutomationDefinitionDraft(command.definition);
      assert.isTrue(Result.isFailure(validated));
      if (Result.isFailure(validated)) {
        assert.strictEqual(validated.failure.field, expectedField);
      }
    }
  }),
);

it.effect("decodes the namespaced command union and requires revisions after create", () =>
  Effect.gen(function* () {
    const create = yield* decodeCommand({
      type: "scheduledAutomation.create",
      commandId: "command-create",
      automationId: "automation-1",
      definition: definition(),
      createdAt: "2026-08-03T09:00:00.000Z",
    });
    assert.strictEqual(create.type, "scheduledAutomation.create");

    const update = yield* decodeCommand({
      type: "scheduledAutomation.update",
      commandId: "command-update",
      automationId: "automation-1",
      expectedRevision: 3,
      definition: definition({ name: "Updated maintenance" }),
      createdAt: "2026-08-03T09:01:00.000Z",
    });
    assert.strictEqual(update.type, "scheduledAutomation.update");
    if (update.type === "scheduledAutomation.update") {
      assert.strictEqual(update.expectedRevision, 3);
    }

    const abandon = yield* decodeCommand({
      type: "scheduledAutomation.failed.abandon",
      commandId: "command-abandon",
      automationId: "automation-1",
      expectedRevision: 4,
      createdAt: "2026-08-03T09:01:30.000Z",
    });
    assert.strictEqual(abandon.type, "scheduledAutomation.failed.abandon");

    const missingRevision = yield* Effect.exit(
      decodeCommand({
        type: "scheduledAutomation.enabled.set",
        commandId: "command-enable",
        automationId: "automation-1",
        enabled: true,
        createdAt: "2026-08-03T09:02:00.000Z",
      }),
    );
    assert.strictEqual(missingRevision._tag, "Failure");
  }),
);

it("defaults automation health when decoding a pre-WP5 list or snapshot", () => {
  const expected = {
    status: "healthy",
    schedulerStatus: "starting",
    malformedDefinitionCount: 0,
  } as const;

  assert.deepStrictEqual(decodeListResult({ automations: [] }).health, expected);
  const snapshot = decodeStreamItem({ kind: "snapshot", automations: [] });
  assert.strictEqual(snapshot.kind, "snapshot");
  if (snapshot.kind === "snapshot") assert.deepStrictEqual(snapshot.health, expected);
});
