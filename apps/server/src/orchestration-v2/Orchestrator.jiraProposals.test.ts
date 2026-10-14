import { assert, it } from "@effect/vitest";
import {
  AuthUserId,
  CommandId,
  EventId,
  type JiraProposal,
  type JiraProposalStatus,
  MessageId,
  type OrchestrationV2Run,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { createThread, layerOrchestration, SITE } from "../jira/JiraLinks.testkit.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { isTerminalRunStatus } from "./ThreadManagementService.ts";

const ada = AuthUserId.make("user-ada");
const proposal: JiraProposal = {
  kind: "comment",
  site: SITE,
  key: "ABC-1",
  body: "Shipped in the latest release.",
};

let commandCount = 0;
const nextCommandId = (label: string) => CommandId.make(`proposal-test:${label}:${++commandCount}`);

/** A thread with a started run, as when an agent is mid-turn. */
const startRun = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* createThread(threadId);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: nextCommandId("send"),
      threadId,
      messageId: MessageId.make(`message:${threadId}`),
      text: "Post the release note on ABC-1.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const records = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
    return records.runs[0]!;
  });

const record = (
  run: OrchestrationV2Run,
  turnItemId: TurnItemId,
  proposalStatus: JiraProposalStatus,
  extra: { readonly error?: string; readonly decided?: boolean } = {},
) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "jira_proposal.record",
      commandId: nextCommandId(proposalStatus),
      threadId: run.threadId,
      runId: run.id,
      nodeId: run.rootNodeId!,
      turnItemId,
      proposal,
      proposalStatus,
      ...(extra.decided ? { decidedByUserId: ada, decidedAt: "2026-10-14T12:00:00.000Z" } : {}),
      ...(extra.error === undefined ? {} : { error: extra.error }),
    }),
  );

/** Why the orchestrator refused a command. */
const refusal = (error: Orchestrator.OrchestratorV2Error) =>
  error._tag === "OrchestratorDispatchError" ? String(error.cause) : error.message;

const readCard = (threadId: ThreadId, turnItemId: TurnItemId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"], {
      turnItemTypes: ["jira_proposal"],
    });
    const item = records.turnItems.find((candidate) => candidate.id === turnItemId);
    assert.equal(item?.type, "jira_proposal");
    return item as Extract<typeof item, { readonly type: "jira_proposal" }>;
  });

/** The pending input the shell reports, from the SQL read and from the in-memory projection. */
const pendingInputIds = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const shell = yield* projections.getThreadShell(threadId);
    const memory = ProjectionStore.threadShellFromProjection(
      yield* projections.getThreadProjection(threadId),
    );
    return [shell?.pendingRuntimeRequest?.id, memory.pendingRuntimeRequest?.id].map(
      (id): string | null => id ?? null,
    );
  });

it.effect("moves a proposal through its statuses and shows it as pending input while open", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:jira-proposal-statuses");
    const run = yield* startRun(threadId);
    const turnItemId = TurnItemId.make("turn-item:jira-proposal:statuses");

    yield* record(run, turnItemId, "pending");
    const pending = yield* readCard(threadId, turnItemId);
    assert.include(pending, {
      status: "waiting",
      proposalStatus: "pending",
      title: "Comment on ABC-1",
      runId: run.id,
    });
    assert.deepStrictEqual(yield* pendingInputIds(threadId), [turnItemId, turnItemId]);

    // Repeating the current status changes nothing.
    yield* record(run, turnItemId, "pending");
    assert.deepStrictEqual(yield* readCard(threadId, turnItemId), pending);

    // Only an approval writes; nothing skips it.
    const skipped = yield* record(run, turnItemId, "applied").pipe(Effect.flip);
    assert.include(refusal(skipped), "cannot become applied");

    yield* record(run, turnItemId, "approved", { decided: true });
    assert.include(yield* readCard(threadId, turnItemId), {
      status: "running",
      decidedByUserId: ada,
    });
    yield* record(run, turnItemId, "failed", { decided: true, error: "Jira is down." });
    assert.include(yield* readCard(threadId, turnItemId), {
      status: "failed",
      error: "Jira is down.",
    });
    // A failed approval may be approved again.
    yield* record(run, turnItemId, "approved", { decided: true });
    yield* record(run, turnItemId, "applied", { decided: true });
    const applied = yield* readCard(threadId, turnItemId);
    assert.include(applied, { status: "completed", proposalStatus: "applied" });
    assert.isNotNull(applied.completedAt);
    assert.isUndefined(applied.error);
    assert.deepStrictEqual(yield* pendingInputIds(threadId), [null, null]);

    // Applied is final.
    const reopened = yield* record(run, turnItemId, "rejected").pipe(Effect.flip);
    assert.include(refusal(reopened), "is applied");
    yield* record(run, turnItemId, "applied", { decided: true });
    assert.deepStrictEqual(yield* readCard(threadId, turnItemId), applied);
  }).pipe(Effect.provide(layerOrchestration("jira-proposal-statuses"))),
);

it.effect("keeps a proposal open and decidable after its run ends", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:jira-proposal-outlives-run");
    const run = yield* startRun(threadId);
    const turnItemId = TurnItemId.make("turn-item:jira-proposal:outlives");
    yield* record(run, turnItemId, "pending");

    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: nextCommandId("stop"),
      threadId,
      runId: run.id,
      holdQueue: true,
    });
    const ended = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs[0]!;
    assert.isTrue(isTerminalRunStatus(ended.status));

    // Stopping did not touch the card, and the thread still waits on the user for it.
    assert.include(yield* readCard(threadId, turnItemId), {
      status: "waiting",
      proposalStatus: "pending",
    });
    assert.deepStrictEqual(yield* pendingInputIds(threadId), [turnItemId, turnItemId]);

    yield* record(run, turnItemId, "rejected", { decided: true });
    assert.include(yield* readCard(threadId, turnItemId), {
      status: "cancelled",
      proposalStatus: "rejected",
    });
    assert.deepStrictEqual(yield* pendingInputIds(threadId), [null, null]);
  }).pipe(Effect.provide(layerOrchestration("jira-proposal-outlives-run"))),
);

it.effect("refuses a record outside its run's root or over another kind of item", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:jira-proposal-refusals");
    const run = yield* startRun(threadId);
    const wrongNode = yield* orchestrator
      .dispatch({
        type: "jira_proposal.record",
        commandId: nextCommandId("wrong-node"),
        threadId,
        runId: run.id,
        nodeId: "node:not-the-root" as never,
        turnItemId: TurnItemId.make("turn-item:jira-proposal:refused"),
        proposal,
        proposalStatus: "pending",
      })
      .pipe(Effect.flip);
    assert.include(refusal(wrongNode), "is not the root of run");

    // The user's own message item is no proposal.
    const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
    const message = records.turnItems.find((item) => item.type === "user_message")!;
    const overwrite = yield* record(run, message.id, "pending").pipe(Effect.flip);
    assert.include(refusal(overwrite), "is not a Jira proposal");
  }).pipe(Effect.provide(layerOrchestration("jira-proposal-refusals"))),
);

it.effect("records another approval of the same status, and ignores an exact replay", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:jira-proposal-reapproved");
    const run = yield* startRun(threadId);
    const turnItemId = TurnItemId.make("turn-item:jira-proposal:reapproved");
    yield* record(run, turnItemId, "pending");
    const approve = (userId: AuthUserId, decidedAt: string, body: string) =>
      orchestrator.dispatch({
        type: "jira_proposal.record",
        commandId: nextCommandId("approved"),
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        turnItemId,
        proposal: { ...proposal, body },
        proposalStatus: "approved",
        decidedByUserId: userId,
        decidedAt,
      });

    yield* approve(ada, "2026-10-14T12:00:00.000Z", proposal.body);
    const first = yield* readCard(threadId, turnItemId);
    // An approval taking over an interrupted one records its own approver, time and edits.
    const grace = AuthUserId.make("user-grace");
    yield* approve(grace, "2026-10-14T13:00:00.000Z", "Shipped in 1.2.");
    const second = yield* readCard(threadId, turnItemId);
    assert.include(second, {
      proposalStatus: "approved",
      decidedByUserId: grace,
      decidedAt: "2026-10-14T13:00:00.000Z",
    });
    assert.include(second.proposal, { body: "Shipped in 1.2." });
    assert.equal(second.ordinal, first.ordinal);

    yield* approve(grace, "2026-10-14T13:00:00.000Z", "Shipped in 1.2.");
    assert.deepStrictEqual(yield* readCard(threadId, turnItemId), second);
  }).pipe(Effect.provide(layerOrchestration("jira-proposal-reapproved"))),
);

it.effect("stops waiting on a proposal whose turn was rolled back", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:jira-proposal-rolled-back");
    const run = yield* startRun(threadId);
    const turnItemId = TurnItemId.make("turn-item:jira-proposal:rolled-back");
    yield* record(run, turnItemId, "pending");
    const settleable = Effect.map(projections.getSettlementCandidates(), (candidates) =>
      candidates.some((candidate) => candidate.id === threadId),
    );
    const interrupted = { ...run, status: "interrupted" as const };
    yield* projections.apply({
      id: EventId.make("event:jira-proposal-rolled-back:stopped"),
      type: "run.updated",
      threadId,
      runId: run.id,
      nodeId: run.rootNodeId!,
      providerInstanceId: run.providerInstanceId,
      occurredAt: DateTime.makeUnsafe("2026-10-14T12:00:00.000Z"),
      payload: interrupted,
    });
    // An ended run's proposal still waits on the user, and holds the thread open.
    assert.deepStrictEqual(yield* pendingInputIds(threadId), [turnItemId, turnItemId]);
    assert.isFalse(yield* settleable);

    yield* projections.apply({
      id: EventId.make("event:jira-proposal-rolled-back:rolled-back"),
      type: "run.updated",
      threadId,
      runId: run.id,
      nodeId: run.rootNodeId!,
      providerInstanceId: run.providerInstanceId,
      occurredAt: DateTime.makeUnsafe("2026-10-14T12:01:00.000Z"),
      payload: { ...interrupted, status: "rolled_back" },
    });
    assert.deepStrictEqual(yield* pendingInputIds(threadId), [null, null]);
    assert.isTrue(yield* settleable);
  }).pipe(Effect.provide(layerOrchestration("jira-proposal-rolled-back"))),
);
