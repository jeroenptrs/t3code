import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  AuthUserId,
  CommandId,
  type JiraProposalStatus,
  MessageId,
  OrchestrationV2Command,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as JiraApi from "./JiraApi.ts";
import * as JiraIdentities from "./JiraIdentities.ts";
import {
  createThread,
  jiraConfig,
  layerOrchestration,
  SITE,
  threadLinks,
} from "./JiraLinks.testkit.ts";
import * as JiraProposals from "./JiraProposals.ts";
import * as JiraReadCache from "./JiraReadCache.ts";
import * as JiraService from "./JiraService.ts";
import * as JiraUserCredentials from "./JiraUserCredentials.ts";

/** What a client may dispatch over the WebSocket. */
const decodeClientCommand = Schema.decodeUnknownOption(OrchestrationV2Command);

const ALICE = AuthUserId.make("alice");
const BOB = AuthUserId.make("bob");
const codex = ProviderInstanceId.make("codex");

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly who: string;
  readonly body: unknown;
}

const FIELDS = [
  { id: "summary", name: "Summary" },
  {
    id: "customfield_10020",
    name: "Sprint",
    schema: { type: "array", custom: "com.pyxis.greenhopper.jira:gh-sprint" },
  },
  {
    id: "customfield_10016",
    name: "Story point estimate",
    schema: { type: "number", custom: "com.atlassian.jira.plugin.system.customfieldtypes:float" },
  },
];

const basic = (who: string) =>
  `Basic ${Buffer.from(`${who}@acme.test:${who}-token`).toString("base64")}`;

/**
 * Jira as the bot's bearer token and Alice's and Bob's personal tokens. Created issues are
 * numbered from ABC-101; `failCreates` makes the given create attempts (1-based) fail once.
 */
const makeJira = (options: {
  readonly failCreates?: ReadonlyArray<number>;
  readonly transitionsFor?: (who: string) => ReadonlyArray<unknown>;
}) => {
  const requests: Array<Recorded> = [];
  let createAttempts = 0;
  let created = 100;
  const transitions = [
    {
      id: "21",
      name: "Start review",
      to: { name: "In Review", statusCategory: { key: "indeterminate" } },
    },
    { id: "31", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
  ];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined;
      const authorization = request.headers.authorization;
      const who =
        authorization === "Bearer token"
          ? "bot"
          : (["alice", "bob"].find((name) => authorization === basic(name)) ?? "nobody");
      const path = url.pathname.replace(/^\/ex\/jira\/cloud-\d/, "");
      requests.push({ method: request.method, path, who, body });
      const answer = (status: number, json: unknown) =>
        HttpClientResponse.fromWeb(
          request,
          new Response(json === null ? null : JSON.stringify(json), { status }),
        );
      if (path === "/_edge/tenant_info") return answer(200, { cloudId: "cloud-1" });
      if (who === "nobody") return answer(401, null);
      if (path === "/rest/api/3/myself") {
        return answer(200, { accountId: `acc-${who}`, displayName: who });
      }
      if (path === "/rest/api/3/field") return answer(200, FIELDS);
      if (request.method === "POST" && path === "/rest/api/3/issue") {
        createAttempts += 1;
        if (options.failCreates?.includes(createAttempts)) {
          return answer(400, { errors: { summary: "Summary is too vague." } });
        }
        created += 1;
        return answer(201, { id: String(created), key: `ABC-${created}` });
      }
      const issuePath = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/(comment|transitions)$/.exec(path);
      if (issuePath?.[2] === "comment") return answer(201, { id: "c-1" });
      if (issuePath?.[2] === "transitions") {
        return request.method === "GET"
          ? answer(200, { transitions: options.transitionsFor?.(who) ?? transitions })
          : answer(204, null);
      }
      return answer(404, null);
    }),
  );
  return { requests, client };
};

const memorySecretStore = Layer.sync(ServerSecretStore.ServerSecretStore, () => {
  const entries = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(entries.get(name))),
    set: (name, value) => Effect.sync(() => void entries.set(name, value)),
    create: (name, value) => Effect.sync(() => void entries.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void entries.delete(name)),
  });
});

/** Real orchestration, proposals, Jira service and personal tokens; only Jira's HTTP is fake. */
const layerFor = (name: string, client: HttpClient.HttpClient) =>
  JiraProposals.layer.pipe(
    Layer.provideMerge(JiraService.layer),
    Layer.provideMerge(JiraUserCredentials.layer),
    Layer.provide(JiraApi.layer),
    Layer.provide(JiraReadCache.layer),
    Layer.provide(Layer.succeed(JiraIdentities.JiraIdentities, JiraIdentities.make(jiraConfig))),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(memorySecretStore),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(layerOrchestration(name)),
  );

const storeToken = (userId: AuthUserId, who: string) =>
  Effect.flatMap(JiraUserCredentials.JiraUserCredentials, (credentials) =>
    credentials.set(userId, { email: `${who}@acme.test`, token: `${who}-token` }),
  );

let commandCount = 0;

/** A thread whose agent is mid-turn on the codex instance. */
const startRun = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* createThread(threadId);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`proposals-test:send:${++commandCount}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}`),
      text: "Plan the work in Jira.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    return (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs[0]!;
  });

/** Forks the agent's propose call and returns once its card is recorded as pending. */
const propose = (
  threadId: ThreadId,
  request: JiraProposals.JiraProposalRequest,
  clientRequestId: string,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const proposals = yield* JiraProposals.JiraProposals;
    const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
    const call = yield* proposals
      .propose({ threadId, providerInstanceId: codex, request, clientRequestId })
      .pipe(Effect.forkChild);
    // A call that ends before its card shows up failed; surface why instead of waiting on.
    const proposalId = yield* Effect.raceFirst(
      awaitCard(threadId, afterSequence, "pending").pipe(Effect.map((card) => card.id)),
      Fiber.join(call).pipe(
        Effect.flatMap((outcome) => Effect.die(`propose returned first: ${outcome.status}`)),
      ),
    );
    return { call, proposalId };
  });

/** The first time the thread's events show a proposal card in `status`. */
const awaitCard = (threadId: ThreadId, afterSequence: number, status: JiraProposalStatus) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
      Stream.map(({ event }) =>
        event.type === "turn-item.updated" &&
        event.payload.type === "jira_proposal" &&
        event.payload.proposalStatus === status
          ? event.payload
          : null,
      ),
      Stream.filter((card) => card !== null),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    ),
  );

const readCard = (threadId: ThreadId, proposalId: TurnItemId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"], {
      turnItemTypes: ["jira_proposal"],
    });
    const item = records.turnItems.find((candidate) => candidate.id === proposalId);
    if (item?.type !== "jira_proposal") return assert.fail("The proposal card is missing.");
    return item;
  });

const decide = (
  userId: AuthUserId | undefined,
  threadId: ThreadId,
  proposalId: TurnItemId,
  decision: Parameters<JiraProposals.JiraProposals["Service"]["decide"]>[1]["decision"],
) =>
  Effect.flatMap(JiraProposals.JiraProposals, (proposals) =>
    proposals.decide(userId, { threadId, proposalId, decision }),
  );

const draft = (summary: string) => ({ projectKey: "ABC", issueType: "Story", summary });

it.effect("approves a proposal only as a signed-in user with their own token, once", () => {
  const jira = makeJira({});
  return Effect.gen(function* () {
    const threadId = ThreadId.make("thread:proposal-approve");
    yield* startRun(threadId);
    const request = {
      kind: "create-issues",
      issues: [
        {
          ...draft("Login page"),
          description: "Users sign in with **SSO**.",
          labels: ["auth"],
          storyPoints: 3,
          sprintId: 7,
        },
        draft("Logout"),
      ],
    } as const;
    const { call, proposalId } = yield* propose(threadId, request, "plan-auth");
    const pending = yield* readCard(threadId, proposalId);
    assert.deepStrictEqual(pending.proposal, {
      kind: "create-issues",
      site: SITE,
      issues: [
        {
          ...draft("Login page"),
          description: "Users sign in with **SSO**.",
          parentKey: null,
          labels: ["auth"],
          storyPoints: 3,
          sprintId: 7,
          assigneeAccountId: null,
        },
        {
          ...draft("Logout"),
          description: null,
          parentKey: null,
          labels: [],
          storyPoints: null,
          sprintId: null,
          assigneeAccountId: null,
        },
      ],
    });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    assert.equal(
      String((yield* projections.getThreadShell(threadId))?.pendingRuntimeRequest?.id),
      proposalId,
    );

    const approve = {
      type: "approve",
      proposal: {
        ...pending.proposal,
        ...(pending.proposal.kind === "create-issues"
          ? {
              issues: pending.proposal.issues.map((issue, index) =>
                index === 1 ? { ...issue, summary: "Log out everywhere" } : issue,
              ),
            }
          : {}),
      },
    } as const;
    const anonymous = yield* decide(undefined, threadId, proposalId, approve).pipe(Effect.flip);
    assert.equal(anonymous.reason, "forbidden");
    // Bob has no personal token: nothing is written, and no shared account stands in.
    const tokenless = yield* decide(BOB, threadId, proposalId, approve).pipe(Effect.flip);
    assert.equal(tokenless.reason, "personal-token-required");
    assert.include(tokenless.message, "Settings → Account");
    assert.isFalse(
      jira.requests.some((entry) => entry.method === "POST" && entry.path === "/rest/api/3/issue"),
    );
    assert.equal((yield* readCard(threadId, proposalId)).proposalStatus, "pending");

    yield* storeToken(ALICE, "alice");
    const outcome = yield* decide(ALICE, threadId, proposalId, approve);
    const issues = [
      { site: SITE, key: "ABC-101", url: `https://${SITE}/browse/ABC-101`, draftIndex: 0 },
      { site: SITE, key: "ABC-102", url: `https://${SITE}/browse/ABC-102`, draftIndex: 1 },
    ];
    assert.deepStrictEqual(outcome, { status: "applied", result: { issues }, error: null });
    const creates = jira.requests.filter(
      (entry) => entry.method === "POST" && entry.path === "/rest/api/3/issue",
    );
    assert.deepStrictEqual(
      creates.map((entry) => entry.who),
      ["alice", "alice"],
    );
    const [first, second] = creates.map(
      (entry) => (entry.body as { fields: Record<string, unknown> }).fields,
    );
    assert.deepInclude(first, {
      project: { key: "ABC" },
      issuetype: { name: "Story" },
      summary: "Login page",
      labels: ["auth"],
      customfield_10016: 3,
      customfield_10020: 7,
    });
    assert.include(JSON.stringify(first?.description), '"type":"doc"');
    assert.deepStrictEqual(second, {
      project: { key: "ABC" },
      issuetype: { name: "Story" },
      summary: "Log out everywhere",
    });

    // The agent hears the outcome; the card records who approved it.
    const heard = yield* Fiber.join(call);
    assert.deepStrictEqual(heard, {
      proposalId,
      status: "applied",
      result: { issues },
      error: null,
    });
    assert.include(yield* readCard(threadId, proposalId), {
      proposalStatus: "applied",
      decidedByUserId: ALICE,
    });
    assert.isNull((yield* projections.getThreadShell(threadId))?.pendingRuntimeRequest ?? null);
    assert.deepStrictEqual(
      (yield* threadLinks(threadId)).map((link) => [link.key, link.source, link.linkedByUserId]),
      [
        ["ABC-101", "agent", ALICE],
        ["ABC-102", "agent", ALICE],
      ],
    );
    const sql = yield* SqlClient.SqlClient;
    const [ledger] = yield* sql<{
      readonly status: string;
      readonly approved_by_user_id: string;
      readonly requested_by_provider_instance_id: string;
      readonly requested_model: string;
    }>`
      SELECT status, approved_by_user_id, requested_by_provider_instance_id, requested_model
      FROM fork_jira_proposals WHERE proposal_id = ${proposalId}
    `;
    assert.deepStrictEqual(ledger, {
      status: "applied",
      approved_by_user_id: ALICE,
      requested_by_provider_instance_id: "codex",
      requested_model: "gpt-5.4",
    });

    // Approving again, by anyone, returns what was written and writes nothing.
    yield* storeToken(BOB, "bob");
    assert.deepStrictEqual(yield* decide(BOB, threadId, proposalId, approve), outcome);
    assert.lengthOf(
      jira.requests.filter(
        (entry) => entry.method === "POST" && entry.path === "/rest/api/3/issue",
      ),
      2,
    );
  }).pipe(Effect.provide(layerFor("proposal-approve", jira.client)));
});

it.effect("retries a partly failed approval by creating only the missing issues", () => {
  const jira = makeJira({ failCreates: [2] });
  return Effect.gen(function* () {
    const threadId = ThreadId.make("thread:proposal-retry");
    yield* startRun(threadId);
    yield* storeToken(ALICE, "alice");
    const { proposalId } = yield* propose(
      threadId,
      { kind: "create-issues", issues: [draft("One"), draft("Two"), draft("Three")] },
      "plan-three",
    );
    const approve = {
      type: "approve",
      proposal: (yield* readCard(threadId, proposalId)).proposal,
    } as const;

    const failed = yield* decide(ALICE, threadId, proposalId, approve);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "Summary is too vague.");
    assert.deepStrictEqual(
      failed.result?.issues.map((issue) => [issue.key, issue.draftIndex]),
      [["ABC-101", 0]],
    );
    assert.include(yield* readCard(threadId, proposalId), {
      status: "failed",
      error: "Summary is too vague.",
    });

    const retried = yield* decide(ALICE, threadId, proposalId, approve);
    assert.equal(retried.status, "applied");
    assert.deepStrictEqual(
      retried.result?.issues.map((issue) => [issue.key, issue.draftIndex]),
      [
        ["ABC-101", 0],
        ["ABC-102", 1],
        ["ABC-103", 2],
      ],
    );
    const summaries = jira.requests
      .filter((entry) => entry.method === "POST" && entry.path === "/rest/api/3/issue")
      .map((entry) => (entry.body as { fields: { summary: string } }).fields.summary);
    assert.deepStrictEqual(summaries, ["One", "Two", "Two", "Three"]);
  }).pipe(Effect.provide(layerFor("proposal-retry", jira.client)));
});

it.effect("rejects a pending proposal without writing, and keeps it rejected", () => {
  const jira = makeJira({});
  return Effect.gen(function* () {
    const threadId = ThreadId.make("thread:proposal-reject");
    yield* startRun(threadId);
    yield* storeToken(ALICE, "alice");
    const { call, proposalId } = yield* propose(
      threadId,
      { kind: "comment", key: "ABC-1", body: "Done in #42." },
      "comment-1",
    );
    assert.deepStrictEqual(yield* decide(ALICE, threadId, proposalId, { type: "reject" }), {
      status: "rejected",
      result: null,
      error: null,
    });
    assert.include(yield* Fiber.join(call), { status: "rejected" });
    const card = yield* readCard(threadId, proposalId);
    const approved = yield* decide(ALICE, threadId, proposalId, {
      type: "approve",
      proposal: card.proposal,
    });
    assert.equal(approved.status, "rejected");
    assert.isFalse(jira.requests.some((entry) => entry.path.endsWith("/comment")));
  }).pipe(Effect.provide(layerFor("proposal-reject", jira.client)));
});

it.effect("refuses an approval whose transition the issue no longer offers", () => {
  // The bot saw "Start review" when the agent proposed it; by approval the issue moved on.
  const jira = makeJira({
    transitionsFor: (who) =>
      who === "bot"
        ? [{ id: "21", name: "Start review", to: { name: "In Review" } }]
        : [{ id: "41", name: "Reopen", to: { name: "To Do" } }],
  });
  return Effect.gen(function* () {
    const threadId = ThreadId.make("thread:proposal-transition");
    yield* startRun(threadId);
    yield* storeToken(ALICE, "alice");
    const proposals = yield* JiraProposals.JiraProposals;
    const unknown = yield* proposals
      .propose({
        threadId,
        providerInstanceId: codex,
        request: { kind: "transition", key: "ABC-1", transition: "Ship it" },
      })
      .pipe(Effect.flip);
    assert.include(unknown.message, "Available: Start review (→ In Review).");

    const { proposalId } = yield* propose(
      threadId,
      { kind: "transition", key: "ABC-1", transition: "in review", comment: "Ready." },
      "move-1",
    );
    const card = yield* readCard(threadId, proposalId);
    assert.deepInclude(card.proposal, { transitionId: "21", transitionName: "Start review" });
    const outcome = yield* decide(ALICE, threadId, proposalId, {
      type: "approve",
      proposal: card.proposal,
    });
    assert.equal(outcome.status, "failed");
    assert.include(outcome.error, "no longer available on ABC-1");
    assert.isFalse(
      jira.requests.some((entry) => entry.method === "POST" && entry.path.includes("/ABC-1/")),
    );
  }).pipe(Effect.provide(layerFor("proposal-transition", jira.client)));
});

it.effect("keeps a proposal open after its run ends, where only a user can decide it", () => {
  const jira = makeJira({});
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const proposals = yield* JiraProposals.JiraProposals;
    const threadId = ThreadId.make("thread:proposal-outlives-run");
    const run = yield* startRun(threadId);
    const { call, proposalId } = yield* propose(
      threadId,
      { kind: "comment", key: "ABC-1", body: "Released in **1.2**." },
      "comment-after-stop",
    );

    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("proposals-test:stop"),
      threadId,
      runId: run.id,
      holdQueue: true,
    });
    // The agent's wait ends with its run; the card does not.
    assert.include(yield* Fiber.join(call), { proposalId, status: "pending" });
    assert.equal((yield* readCard(threadId, proposalId)).status, "waiting");
    assert.equal(
      String((yield* projections.getThreadShell(threadId))?.pendingRuntimeRequest?.id),
      proposalId,
    );
    // An agent without a live run cannot propose more.
    const stale = yield* proposals
      .propose({
        threadId,
        providerInstanceId: codex,
        request: { kind: "comment", key: "ABC-1", body: "Again." },
      })
      .pipe(Effect.flip);
    assert.equal(stale._tag, "JiraProposalRunInactiveError");

    // The agent-facing pending-request tools read runtime requests; a proposal is none, so they
    // can neither list nor answer it, and no client command can record a decision.
    const records = yield* orchestrator.getThreadRecords(threadId, ["runtimeRequests"]);
    assert.isFalse(records.runtimeRequests.some((request) => String(request.id) === proposalId));
    const answered = yield* orchestrator
      .dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("proposals-test:respond"),
        threadId,
        requestId: RuntimeRequestId.make(proposalId),
        answers: { approve: "yes" },
      })
      .pipe(Effect.flip);
    assert.equal(answered._tag, "OrchestratorDispatchError");
    const recordCommand = {
      type: "jira_proposal.record",
      commandId: "proposals-test:forged",
      threadId,
      runId: run.id,
      nodeId: run.rootNodeId,
      turnItemId: proposalId,
      proposal: (yield* readCard(threadId, proposalId)).proposal,
      proposalStatus: "applied",
    };
    assert.isTrue(Option.isNone(decodeClientCommand(recordCommand)));
    assert.equal((yield* readCard(threadId, proposalId)).proposalStatus, "pending");

    yield* storeToken(ALICE, "alice");
    const outcome = yield* decide(ALICE, threadId, proposalId, {
      type: "approve",
      proposal: (yield* readCard(threadId, proposalId)).proposal,
    });
    assert.equal(outcome.status, "applied");
    const comments = jira.requests.filter(
      (entry) => entry.path === "/rest/api/3/issue/ABC-1/comment",
    );
    assert.deepStrictEqual(
      comments.map((entry) => entry.who),
      ["alice"],
    );
    assert.include(JSON.stringify(comments[0]?.body), '"type":"doc"');
    assert.isNull((yield* projections.getThreadShell(threadId))?.pendingRuntimeRequest ?? null);
  }).pipe(Effect.provide(layerFor("proposal-outlives-run", jira.client)));
});
