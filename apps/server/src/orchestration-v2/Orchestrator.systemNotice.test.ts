import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { createThread, layerOrchestration } from "../jira/JiraLinks.testkit.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";

let commandCount = 0;
const nextCommandId = (label: string) => CommandId.make(`notice-test:${label}:${++commandCount}`);

/** A thread whose first run already completed. */
const endedRun = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    yield* createThread(threadId);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: nextCommandId("send"),
      threadId,
      messageId: MessageId.make(`message:${threadId}`),
      text: "Break down ABC-12.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    });
    const run = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs[0]!;
    const completed: OrchestrationV2Run = {
      ...run,
      status: "completed",
      completedAt: yield* DateTime.now,
    };
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`event:notice-test:${threadId}:completed`),
          type: "run.updated",
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId!,
          providerInstanceId: run.providerInstanceId,
          occurredAt: yield* DateTime.now,
          payload: completed,
        },
      ],
    });
    return completed;
  });

const recordNotice = (
  run: OrchestrationV2Run,
  turnItemId: TurnItemId,
  message: string,
  nodeId = run.rootNodeId!,
) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "system_notice.record",
      commandId: nextCommandId("notice"),
      threadId: run.threadId,
      runId: run.id,
      nodeId,
      turnItemId,
      message,
    }),
  );

const notices = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator
      .getThreadRecords(threadId, ["turnItems"], { turnItemTypes: ["system_notice"] })
      .pipe(Effect.map((records) => records.turnItems)),
  );

it.effect("adds a server notice to a run that already ended, once", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:system-notice");
    const run = yield* endedRun(threadId);
    const turnItemId = TurnItemId.make("turn-item:system-notice:ended");

    yield* recordNotice(run, turnItemId, "The breakdown ended without proposing work packages.");
    const [notice, ...rest] = yield* notices(threadId);
    assert.deepStrictEqual(rest, []);
    assert.include(notice, {
      id: turnItemId,
      type: "system_notice",
      runId: run.id,
      nodeId: run.rootNodeId,
      status: "completed",
      message: "The breakdown ended without proposing work packages.",
    });

    // Recording the same notice again keeps the first.
    yield* recordNotice(run, turnItemId, "Something else.");
    assert.deepStrictEqual(yield* notices(threadId), [notice!]);
  }).pipe(Effect.provide(layerOrchestration("system-notice"))),
);

it.effect("refuses a notice off its run's root or over another kind of item", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:system-notice-refused");
    const run = yield* endedRun(threadId);

    const offRoot = yield* recordNotice(
      run,
      TurnItemId.make("turn-item:system-notice:off-root"),
      "Not at the root.",
      NodeId.make("node:elsewhere"),
    ).pipe(Effect.flip);
    assert.equal(offRoot._tag, "OrchestratorDispatchError");

    const records = yield* Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
      orchestrator.getThreadRecords(threadId, ["turnItems"], { turnItemTypes: ["user_message"] }),
    );
    const userMessage = records.turnItems[0]!;
    const overwrite = yield* recordNotice(run, userMessage.id, "Overwrites the message.").pipe(
      Effect.flip,
    );
    assert.equal(overwrite._tag, "OrchestratorDispatchError");
    assert.deepStrictEqual(yield* notices(threadId), []);
  }).pipe(Effect.provide(layerOrchestration("system-notice-refused"))),
);
