import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  AuthUserId,
  CommandId,
  EventId,
  MessageId,
  type Project,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as JiraApi from "./JiraApi.ts";
import * as JiraBreakdownService from "./JiraBreakdownService.ts";
import * as JiraBreakdownThreads from "./JiraBreakdownThreads.ts";
import * as JiraIdentities from "./JiraIdentities.ts";
import { jiraConfig, layerOrchestration, SITE, threadLinks } from "./JiraLinks.testkit.ts";
import * as JiraReadCache from "./JiraReadCache.ts";
import * as JiraService from "./JiraService.ts";
import * as JiraUserCredentials from "./JiraUserCredentials.ts";

const ALICE = AuthUserId.make("alice");
const BOB = AuthUserId.make("bob");
const projectId = ProjectId.make("project:jira");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const input = { site: SITE, key: "ABC-12", projectId };

const basic = (who: string) =>
  `Basic ${Buffer.from(`${who}@acme.test:${who}-token`).toString("base64")}`;

/** Jira as the bot and Alice's personal token: one story under an epic, in a project with sub-tasks. */
const makeJira = () => {
  const requests: Array<{ readonly path: string; readonly who: string }> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const authorization = request.headers.authorization;
      const who =
        authorization === "Bearer token"
          ? "bot"
          : authorization === basic("alice")
            ? "alice"
            : "nobody";
      const path = url.pathname.replace(/^\/ex\/jira\/cloud-\d/, "");
      requests.push({ path, who });
      const answer = (status: number, json: unknown) =>
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(json), { status }));
      if (path === "/_edge/tenant_info") return answer(200, { cloudId: "cloud-1" });
      if (who === "nobody") return answer(401, {});
      switch (path) {
        case "/rest/api/3/myself":
          return answer(200, { accountId: `acc-${who}`, displayName: who });
        case "/rest/api/3/field":
          return answer(200, [{ id: "summary", name: "Summary" }]);
        case "/rest/api/3/issue/ABC-12":
          return answer(200, {
            id: "10012",
            key: "ABC-12",
            fields: {
              summary: "Import invoices from the bank",
              status: { name: "To Do", statusCategory: { key: "new" } },
              issuetype: { name: "Story", subtask: false, hierarchyLevel: 0 },
              parent: { key: "ABC-1", fields: { summary: "Billing", issuetype: { name: "Epic" } } },
            },
          });
        case "/rest/api/3/issue/ABC-12/comment":
          return answer(200, { comments: [], total: 0 });
        case "/rest/api/3/issue/ABC-12/transitions":
          return answer(200, { transitions: [] });
        case "/rest/api/3/issue/createmeta/ABC/issuetypes":
          return answer(200, {
            issueTypes: [
              { id: "1", name: "Story" },
              { id: "5", name: "Sub-task", subtask: true },
            ],
          });
        default:
          return answer(404, {});
      }
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

const project: Project = {
  id: projectId,
  title: "Billing",
  workspaceRoot: process.cwd(),
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

/**
 * Launches the thread and starts its run through the real orchestrator, without the workspace
 * preparation and provider the real launch service drives.
 */
const layerLaunch = (launches: Ref.Ref<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>) =>
  Layer.effect(
    ThreadLaunch.ThreadLaunchService,
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      return ThreadLaunch.ThreadLaunchService.of({
        launch: (launch) =>
          Effect.gen(function* () {
            yield* Ref.update(launches, (all) => [...all, launch]);
            const threadId = launch.threadId!;
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: launch.commandId,
              threadId,
              projectId: launch.projectId,
              title: launch.title,
              modelSelection: launch.modelSelection,
              runtimeMode: launch.runtimeMode,
              interactionMode: launch.interactionMode,
              branch: null,
              worktreePath: null,
              createdBy: launch.createdBy,
              creationSource: launch.creationSource,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`${launch.commandId}:initial-message`),
              threadId,
              messageId: MessageId.make(`message:${threadId}`),
              text: launch.initialMessage!.text,
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: launch.createdBy,
              creationSource: launch.creationSource,
            });
            const projection = yield* orchestrator.getThreadProjection(threadId);
            return { threadId, projection, resumed: false };
          }).pipe(Effect.orDie),
        checkWorktreeBase: () => Effect.die("unused"),
        retryPreparation: () => Effect.die("unused"),
        prepareRun: () => Effect.die("unused"),
      });
    }),
  );

/** Real orchestration, thread waits and Jira services; Jira's HTTP and the launch are fake. */
const layerFor = (
  name: string,
  client: HttpClient.HttpClient,
  launches: Ref.Ref<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>,
) =>
  JiraBreakdownService.layer.pipe(
    Layer.provideMerge(JiraBreakdownThreads.layer),
    Layer.provide(layerLaunch(launches)),
    Layer.provide(ThreadManagement.layer),
    Layer.provide(CommandReceiptStore.layer),
    Layer.provide(ServerSettings.layerTest({})),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
      }),
    ),
    Layer.provide(IdAllocator.layer),
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

const breakdownRows = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql<{ readonly threadId: string; readonly status: string; readonly reason: string | null }>`
    SELECT thread_id AS "threadId", status, reason FROM fork_jira_breakdowns
    ORDER BY created_at, thread_id
  `,
);

/** Ends the thread's first run with `status`, as its provider would. */
const endRun = (threadId: ThreadId, status: "completed" | "failed") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const run = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs[0]!;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`event:breakdown-test:${threadId}:${status}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId!,
          providerInstanceId: run.providerInstanceId,
          occurredAt: yield* DateTime.now,
          payload: { ...run, status, completedAt: yield* DateTime.now },
        },
      ],
    });
    return run;
  });

it.effect("starts nothing for a caller who is not signed in or has no personal token", () => {
  const jira = makeJira();
  return Effect.gen(function* () {
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
    yield* Effect.gen(function* () {
      const breakdowns = yield* JiraBreakdownService.JiraBreakdownService;
      const anonymous = yield* breakdowns.start(undefined, input).pipe(Effect.flip);
      assert.equal(anonymous.reason, "forbidden");
      const tokenless = yield* breakdowns.start(BOB, input).pipe(Effect.flip);
      assert.equal(tokenless.reason, "personal-token-required");
      assert.include(tokenless.message, "Settings → Account");

      assert.deepStrictEqual(yield* Ref.get(launches), []);
      assert.deepStrictEqual(yield* breakdownRows, []);
      assert.isFalse(jira.requests.some((request) => request.path.includes("ABC-12")));
    }).pipe(Effect.provide(layerFor("breakdown-refused", jira.client, launches)));
  });
});

it.effect("starts one breakdown thread per issue while it runs and links the issue to it", () => {
  const jira = makeJira();
  return Effect.gen(function* () {
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
    yield* Effect.gen(function* () {
      const breakdowns = yield* JiraBreakdownService.JiraBreakdownService;
      const threads = yield* JiraBreakdownThreads.JiraBreakdownThreads;
      yield* storeToken(ALICE, "alice");

      // Two presses at once start one thread between them.
      const [first, second] = yield* Effect.all(
        [breakdowns.start(ALICE, input), breakdowns.start(ALICE, input)],
        { concurrency: "unbounded" },
      );
      assert.equal(first.threadId, second.threadId);
      assert.deepStrictEqual([first.started, second.started].toSorted(), [false, true]);
      const again = yield* breakdowns.start(ALICE, input);
      assert.deepStrictEqual(again, { threadId: first.threadId, started: false });

      const [launch, ...others] = yield* Ref.get(launches);
      assert.deepStrictEqual(others, []);
      assert.include(launch, {
        threadId: first.threadId,
        title: "Break down ABC-12: Import invoices from the bank",
        createdBy: "user",
        creationSource: "server",
        createdByUserId: ALICE,
      });
      assert.deepStrictEqual(launch!.modelSelection, modelSelection);
      assert.deepStrictEqual(launch!.workspaceStrategy, { type: "root" });
      const message = launch!.initialMessage!.text;
      assert.include(message, "## ABC-12: Import invoices from the bank");
      assert.include(message, "- Type: Story (standard level)");
      assert.include(message, "- Parent: ABC-1 (Epic): Billing");
      assert.include(message, "- Issue types: Story, Sub-task (sub-task)");
      assert.include(message, "do not edit files");
      // Read as Alice, whose token any proposal will be approved with.
      assert.isTrue(
        jira.requests
          .filter((request) => request.path.startsWith("/rest/api/3/issue/ABC-12"))
          .every((request) => request.who === "alice"),
      );

      assert.deepStrictEqual(
        (yield* threadLinks(first.threadId)).map((link) => [link.key, link.source]),
        [["ABC-12", "manual"]],
      );
      assert.isTrue(yield* threads.isBreakdownThread(first.threadId));
      assert.isFalse(yield* threads.isBreakdownThread(ThreadId.make("thread:ordinary")));
    }).pipe(Effect.provide(layerFor("breakdown-join", jira.client, launches)));
  });
});

it.effect("records a breakdown whose run proposed work packages as proposed", () => {
  const jira = makeJira();
  return Effect.gen(function* () {
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
    yield* Effect.gen(function* () {
      const breakdowns = yield* JiraBreakdownService.JiraBreakdownService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* storeToken(ALICE, "alice");
      const { threadId } = yield* breakdowns.start(ALICE, input);
      const run = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs[0]!;
      yield* orchestrator.dispatch({
        type: "jira_proposal.record",
        commandId: CommandId.make("breakdown-test:propose"),
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        turnItemId: TurnItemId.make("turn-item:breakdown-test:proposal"),
        proposal: {
          kind: "create-issues",
          site: SITE,
          issues: [
            {
              projectKey: "ABC",
              issueType: "Sub-task",
              summary: "ABC-12: Parse the bank's CSV export",
              description: null,
              parentKey: "ABC-12",
              labels: [],
              storyPoints: 3,
              sprintId: null,
              assigneeAccountId: null,
            },
          ],
        },
        proposalStatus: "pending",
      });
      yield* endRun(threadId, "completed");

      assert.equal(yield* breakdowns.follow(threadId), "proposed");
      assert.deepStrictEqual(yield* breakdownRows, [
        { threadId, status: "proposed", reason: null },
      ]);
      const notices = yield* orchestrator.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["system_notice"],
      });
      assert.deepStrictEqual(notices.turnItems, []);
    }).pipe(Effect.provide(layerFor("breakdown-proposed", jira.client, launches)));
  });
});

it.effect("says in the thread why a breakdown ended without proposing anything", () => {
  const jira = makeJira();
  return Effect.gen(function* () {
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
    yield* Effect.gen(function* () {
      const breakdowns = yield* JiraBreakdownService.JiraBreakdownService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* storeToken(ALICE, "alice");
      const { threadId } = yield* breakdowns.start(ALICE, input);
      const run = yield* endRun(threadId, "completed");

      assert.equal(yield* breakdowns.follow(threadId), "no-proposal");
      const [row] = yield* breakdownRows;
      assert.include(row, { threadId, status: "no-proposal" });
      assert.include(row!.reason, "without proposing");
      const notices = yield* orchestrator.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["system_notice"],
      });
      assert.equal(notices.turnItems.length, 1);
      assert.include(notices.turnItems[0], { runId: run.id, status: "completed" });
      assert.include(
        notices.turnItems[0]!.type === "system_notice" ? notices.turnItems[0]!.message : "",
        "The breakdown ended without proposing work packages.",
      );

      // A breakdown that ended is not joined; pressing again starts another.
      const next = yield* breakdowns.start(ALICE, input);
      assert.isTrue(next.started);
      assert.notEqual(next.threadId, threadId);
    }).pipe(Effect.provide(layerFor("breakdown-no-proposal", jira.client, launches)));
  });
});
