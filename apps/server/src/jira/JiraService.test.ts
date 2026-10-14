import { expect, it } from "@effect/vitest";
import { AuthUserId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import type { JiraConfig } from "./JiraConfig.ts";
import * as JiraApi from "./JiraApi.ts";
import * as JiraIdentities from "./JiraIdentities.ts";
import * as JiraReadCache from "./JiraReadCache.ts";
import {
  SITE,
  archiveThread,
  createThread,
  deleteThread,
  layerOrchestration,
  linkIssue,
  unlinkIssue,
} from "./JiraLinks.testkit.ts";
import * as JiraService from "./JiraService.ts";
import * as JiraUserCredentials from "./JiraUserCredentials.ts";

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

const config: JiraConfig = {
  reader: "bot",
  identities: [
    {
      name: "bot",
      site: "acme.atlassian.net",
      authMethod: "scoped-token",
      token: Redacted.make("secret-token"),
      cloudId: "cloud-1",
    },
  ],
};

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

const issue = (key: string) => ({
  id: key,
  key,
  fields: {
    summary: `Issue ${key}`,
    status: { name: "Done", statusCategory: { key: "done" } },
    customfield_10016: 3,
  },
});

/** A fake Jira answering by path and authorization; every request is recorded. */
const makeJira = (
  respond: (
    path: string,
    body: unknown,
    authorization: string | undefined,
  ) => { status: number; body: unknown },
) => {
  const requests: Array<Recorded> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });
      const path = url.pathname.replace("/ex/jira/cloud-1", "");
      const answer = respond(path, body, request.headers.authorization);
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(answer.body), { status: answer.status }),
      );
    }),
  );
  return { requests, client };
};

/** Personal tokens live in memory; everything else is the real service. */
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

const serviceLayer = (jiraConfig: JiraConfig | undefined, client: HttpClient.HttpClient) =>
  JiraService.layer.pipe(
    Layer.provideMerge(JiraUserCredentials.layer),
    Layer.provide(memorySecretStore),
    Layer.provide(JiraApi.layer),
    Layer.provide(JiraReadCache.layer),
    Layer.provide(Layer.succeed(JiraIdentities.JiraIdentities, JiraIdentities.make(jiraConfig))),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const run = <A, E>(
  jiraConfig: JiraConfig | undefined,
  client: HttpClient.HttpClient,
  effect: Effect.Effect<
    A,
    E,
    JiraService.JiraService | JiraUserCredentials.JiraUserCredentials | SqlClient.SqlClient
  >,
) => effect.pipe(Effect.provide(serviceLayer(jiraConfig, client)));

it.effect("capabilities says unconfigured without touching Jira", () => {
  const jira = makeJira(() => ({ status: 500, body: null }));
  return run(
    undefined,
    jira.client,
    Effect.gen(function* () {
      const service = yield* JiraService.JiraService;
      expect(yield* service.capabilities()).toEqual({
        configured: false,
        identities: [],
        reader: null,
        viewer: null,
        readerError: null,
        personalTokens: false,
        personalCredential: null,
      });
      expect((yield* service.search({ jql: "project = ABC" }).pipe(Effect.flip)).reason).toBe(
        "not-configured",
      );
      expect(jira.requests).toEqual([]);
    }),
  );
});

it.effect("capabilities reports a rejected reader instead of failing", () => {
  const jira = makeJira(() => ({ status: 401, body: { errorMessages: ["Unauthorized"] } }));
  return run(
    config,
    jira.client,
    Effect.gen(function* () {
      const capabilities = yield* (yield* JiraService.JiraService).capabilities();
      expect(capabilities.configured).toBe(true);
      expect(capabilities.reader).toEqual({
        name: "bot",
        site: "acme.atlassian.net",
        authMethod: "scoped-token",
        reader: true,
      });
      expect(capabilities.viewer).toBeNull();
      expect(capabilities.readerError).toContain("bot");
      expect(jira.requests[0]).toMatchObject({
        url: "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/myself",
        authorization: "Bearer secret-token",
      });
    }),
  );
});

it.effect("searches a saved filter's JQL with the site's custom fields, and caches it", () => {
  const jira = makeJira((path) => {
    switch (path) {
      case "/rest/api/3/filter/10000":
        return {
          status: 200,
          body: { id: "10000", name: "Mine", jql: "assignee = currentUser()", favourite: true },
        };
      case "/rest/api/3/field":
        return { status: 200, body: FIELDS };
      case "/rest/api/3/search/jql":
        return { status: 200, body: { issues: [issue("ABC-1")], nextPageToken: "next" } };
      default:
        return { status: 404, body: null };
    }
  });
  return run(
    config,
    jira.client,
    Effect.gen(function* () {
      const service = yield* JiraService.JiraService;
      const result = yield* service.search({ filterId: "10000" });
      expect(result.filter).toMatchObject({ id: "10000", name: "Mine", favourite: true });
      expect(result.nextPageToken).toBe("next");
      expect(result.issues.map((summary) => [summary.key, summary.storyPoints])).toEqual([
        ["ABC-1", 3],
      ]);
      const search = jira.requests.find((request) => request.url.endsWith("/search/jql"));
      expect(search?.body).toEqual({
        jql: "assignee = currentUser()",
        fields: [
          "summary",
          "status",
          "issuetype",
          "priority",
          "assignee",
          "updated",
          "customfield_10020",
          "customfield_10016",
        ],
        maxResults: 100,
      });

      const count = jira.requests.length;
      yield* service.search({ filterId: "10000" });
      expect(jira.requests.length).toBe(count);

      // A refresh re-reads the filter and the page, then serves later reads from the cache.
      yield* service.search({ filterId: "10000", refresh: true });
      expect(jira.requests.slice(count).map((request) => new URL(request.url).pathname)).toEqual([
        "/ex/jira/cloud-1/rest/api/3/filter/10000",
        "/ex/jira/cloud-1/rest/api/3/search/jql",
      ]);
      yield* service.search({ filterId: "10000" });
      expect(jira.requests.length).toBe(count + 2);

      const both = yield* service.search({ filterId: "10000", jql: "x" }).pipe(Effect.flip);
      expect(both.reason).toBe("invalid");
      expect((yield* service.search({}).pipe(Effect.flip)).reason).toBe("invalid");
    }),
  );
});

it.effect("reads an issue once until a refresh asks Jira again", () => {
  const jira = makeJira((path) => {
    switch (path) {
      case "/rest/api/3/field":
        return { status: 200, body: FIELDS };
      case "/rest/api/3/issue/ABC-1":
        return { status: 200, body: issue("ABC-1") };
      case "/rest/api/3/issue/ABC-1/comment":
        return { status: 200, body: { comments: [], total: 0 } };
      case "/rest/api/3/issue/ABC-1/transitions":
        return { status: 200, body: { transitions: [] } };
      default:
        return { status: 404, body: null };
    }
  });
  const issueReads = () =>
    jira.requests.filter((request) => new URL(request.url).pathname.endsWith("/issue/ABC-1"))
      .length;
  return run(
    config,
    jira.client,
    Effect.gen(function* () {
      const service = yield* JiraService.JiraService;
      const input = { site: SITE, key: "ABC-1" };
      expect((yield* service.issue(input)).summary).toBe("Issue ABC-1");
      yield* service.issue(input);
      expect(issueReads()).toBe(1);
      yield* service.issue({ ...input, refresh: true });
      expect(issueReads()).toBe(2);
      yield* service.issue(input);
      expect(issueReads()).toBe(2);
    }),
  );
});

it.effect("reports rejected JQL with Jira's own message", () => {
  const jira = makeJira((path) =>
    path === "/rest/api/3/field"
      ? { status: 200, body: FIELDS }
      : {
          status: 400,
          body: { errorMessages: ["Error in the JQL Query: Expecting operator."], errors: {} },
        },
  );
  return run(
    config,
    jira.client,
    Effect.gen(function* () {
      const error = yield* (yield* JiraService.JiraService)
        .search({ jql: "project ABC" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        reason: "invalid",
        message: "Error in the JQL Query: Expecting operator.",
      });
    }),
  );
});

it.effect("fetches many keys in one request per hundred, dropping malformed keys", () => {
  const jira = makeJira((path, body) => {
    if (path === "/rest/api/3/field") return { status: 200, body: FIELDS };
    const keys = (body as { issueIdsOrKeys: ReadonlyArray<string> }).issueIdsOrKeys;
    // ABC-2 is not visible to the reader, so Jira leaves it out.
    return {
      status: 200,
      body: { issues: keys.filter((key) => key !== "ABC-2").map(issue), issueErrors: [] },
    };
  });
  return run(
    config,
    jira.client,
    Effect.gen(function* () {
      const service = yield* JiraService.JiraService;
      const keys = Array.from({ length: 150 }, (_, index) => `ABC-${index + 1}`);
      const summaries = yield* service.issuesByKeys("acme.atlassian.net", [
        ...keys,
        "ABC-1",
        "not a key",
      ]);
      expect(summaries.length).toBe(149);
      expect(summaries.some((summary) => summary.key === "ABC-2")).toBe(false);
      const bulk = jira.requests.filter((request) => request.url.endsWith("/issue/bulkfetch"));
      expect(
        bulk.map(
          (request) => (request.body as { issueIdsOrKeys: unknown[] }).issueIdsOrKeys.length,
        ),
      ).toEqual([100, 50]);
    }),
  );
});

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect("finds known pull requests that name the issue in their branch or title", () => {
  const jira = makeJira(() => ({ status: 500, body: null }));
  return run(
    config,
    jira.client,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-09-01T00:00:00.000Z";
      const link = (
        number: number,
        source: string,
        snapshot: { title: string; headBranch: string } | null,
      ) => ({
        host: "github.com",
        repository: "acme/web",
        number,
        url: `https://github.com/acme/web/pull/${number}`,
        source,
        linkedAt: createdAt,
        stack: null,
        snapshot:
          snapshot === null
            ? null
            : {
                ...snapshot,
                state: "open",
                baseBranch: "main",
                isDraft: false,
                updatedAt: null,
                syncedAt: createdAt,
              },
      });
      const threads = [
        {
          id: "t1",
          deleted: false,
          pullRequests: [
            link(1, "manual", { title: "Login fix", headBranch: "feature/abc-12-login" }),
            link(2, "manual", { title: "ABC-12: follow-up", headBranch: "follow-up" }),
            link(3, "manual", { title: "ABC-123 is different", headBranch: "abc-123" }),
            link(4, "stack-dismissed", { title: "ABC-12 dismissed", headBranch: "x" }),
            link(5, "manual", null),
          ],
        },
        {
          id: "t2",
          deleted: false,
          pullRequests: [
            link(1, "agent", { title: "Login fix", headBranch: "feature/abc-12-login" }),
          ],
        },
        {
          id: "t3",
          deleted: true,
          pullRequests: [link(6, "manual", { title: "ABC-12 deleted", headBranch: "y" })],
        },
      ];
      for (const thread of threads) {
        const payload = yield* encodePayload({ pullRequests: thread.pullRequests });
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, deleted_at, payload_json
          ) VALUES (
            ${thread.id}, 'project-1', ${thread.id}, 'codex', 'full-access', 'default',
            ${createdAt}, ${createdAt}, ${thread.deleted ? createdAt : null}, ${payload}
          )
        `;
      }

      const found = yield* (yield* JiraService.JiraService).pullRequestsForIssue({
        site: "acme.atlassian.net",
        key: "ABC-12",
      });
      expect(
        found
          .map((pullRequest) => ({ number: pullRequest.number, threadIds: pullRequest.threadIds }))
          .toSorted((a, b) => a.number - b.number),
      ).toEqual([
        { number: 1, threadIds: ["t1", "t2"] },
        { number: 2, threadIds: ["t1"] },
      ]);
      expect(found.find((pullRequest) => pullRequest.number === 1)).toMatchObject({
        host: "github.com",
        repository: "acme/web",
        title: "Login fix",
        state: "open",
        headBranch: "feature/abc-12-login",
      });
    }),
  );
});

it.effect("linked threads leave out dismissed links and deleted threads", () => {
  const jira = makeJira(() => ({ status: 500, body: null }));
  return Effect.gen(function* () {
    const kept = ThreadId.make("thread:kept");
    const archived = ThreadId.make("thread:archived");
    const dismissed = ThreadId.make("thread:dismissed");
    const deleted = ThreadId.make("thread:deleted");
    for (const threadId of [kept, archived, dismissed, deleted]) yield* createThread(threadId);
    yield* linkIssue(kept, "ABC-7", "manual");
    yield* linkIssue(archived, "ABC-7", "agent");
    yield* archiveThread(archived);
    yield* linkIssue(dismissed, "ABC-7", "branch");
    yield* unlinkIssue(dismissed, "ABC-7");
    yield* linkIssue(deleted, "ABC-7", "agent");
    yield* deleteThread(deleted);

    const found = yield* (yield* JiraService.JiraService).linkedThreads({
      site: SITE,
      key: "ABC-7",
    });
    expect(
      found
        .map((thread) => [thread.id, thread.source, thread.archivedAt !== null])
        .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
    ).toEqual([
      [archived, "agent", true],
      [kept, "manual", false],
    ]);
    expect(jira.requests).toEqual([]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(serviceLayer(config, jira.client), layerOrchestration("jira-linked-threads")),
    ),
  );
});

const ALICE = AuthUserId.make("alice");
const BOB = AuthUserId.make("bob");
const basic = (who: string) =>
  `Basic ${Buffer.from(`${who}@acme.test:${who}-token`).toString("base64")}`;

/** Jira as three accounts: the bot's bearer token and Alice's and Bob's personal tokens. */
const makePeopleJira = (rejected: Set<string>) =>
  makeJira((path, _body, authorization) => {
    if (path === "/_edge/tenant_info") return { status: 200, body: { cloudId: "cloud-1" } };
    const who =
      authorization === "Bearer secret-token"
        ? "bot"
        : ["alice", "bob"].find((name) => authorization === basic(name));
    if (who === undefined || rejected.has(who)) return { status: 401, body: null };
    switch (path) {
      case "/rest/api/3/myself":
        return { status: 200, body: { accountId: `acc-${who}`, displayName: who } };
      case "/rest/api/3/filter/10000":
        return { status: 200, body: { id: "10000", name: `Seen by ${who}`, jql: "x" } };
      default:
        return { status: 404, body: null };
    }
  });

const storeToken = (userId: AuthUserId, who: string) =>
  Effect.gen(function* () {
    const credentials = yield* JiraUserCredentials.JiraUserCredentials;
    yield* credentials.set(userId, { email: `${who}@acme.test`, token: `${who}-token` });
  });

it.effect("reads as the acting user's own token, and as the reader for everyone else", () => {
  const jira = makePeopleJira(new Set());
  return run(
    config,
    jira.client,
    Effect.gen(function* () {
      const service = yield* JiraService.JiraService;
      yield* storeToken(ALICE, "alice");
      yield* storeToken(BOB, "bob");
      const filterReads = () =>
        jira.requests.filter((request) => request.url.endsWith("/filter/10000")).length;
      const nameFor = (actingUserId?: AuthUserId) =>
        service.filter({ id: "10000" }, { actingUserId }).pipe(Effect.map((view) => view.name));

      expect(yield* nameFor(ALICE)).toBe("Seen by alice");
      expect(yield* nameFor(BOB)).toBe("Seen by bob");
      expect(yield* nameFor()).toBe("Seen by bot");
      expect(yield* nameFor(AuthUserId.make("carol"))).toBe("Seen by bot");
      expect(filterReads()).toBe(3);
      // Each account's read is cached for that account only.
      expect(yield* nameFor(ALICE)).toBe("Seen by alice");
      expect(filterReads()).toBe(3);

      const capabilities = yield* service.capabilities({ actingUserId: ALICE });
      expect(capabilities.personalTokens).toBe(true);
      expect(capabilities.personalCredential?.account?.accountId).toBe("acc-alice");
      expect(capabilities.viewer?.accountId).toBe("acc-bot");
      expect(yield* service.capabilities()).toMatchObject({
        personalTokens: false,
        personalCredential: null,
      });
    }),
  );
});

it.effect("a personal token Jira rejects is recorded and never falls back to the reader", () => {
  const rejected = new Set<string>();
  const jira = makePeopleJira(rejected);
  return run(
    config,
    jira.client,
    Effect.gen(function* () {
      const service = yield* JiraService.JiraService;
      yield* storeToken(ALICE, "alice");
      rejected.add("alice");
      const count = jira.requests.length;

      const error = yield* service
        .filter({ id: "10000" }, { actingUserId: ALICE })
        .pipe(Effect.flip);
      expect(error.reason).toBe("unauthorized");
      expect(error.message).toContain("Settings → Account");
      expect(
        jira.requests.slice(count).map((request) => request.authorization === basic("alice")),
      ).toEqual([true]);

      const capabilities = yield* service.capabilities({ actingUserId: ALICE });
      expect(capabilities.personalCredential?.error).toBe(
        "Jira rejected your personal Jira token.",
      );
    }),
  );
});

it.effect(
  "offers a project's issue types and open sprints for editing a proposal, as the caller",
  () => {
    const sprint = (id: number, state: string) => ({ id, name: `Sprint ${id}`, state, boardId: 1 });
    const people = makeJira((path, body, authorization) => {
      if (path === "/_edge/tenant_info") return { status: 200, body: { cloudId: "cloud-1" } };
      if (authorization !== basic("alice") && authorization !== "Bearer secret-token") {
        return { status: 401, body: null };
      }
      switch (path) {
        case "/rest/api/3/myself":
          return { status: 200, body: { accountId: "acc-alice", displayName: "alice" } };
        case "/rest/api/3/field":
          return { status: 200, body: FIELDS };
        case "/rest/api/3/issue/createmeta/ABC/issuetypes":
          return {
            status: 200,
            body: {
              issueTypes: [
                { id: "1", name: "Geschichte", untranslatedName: "Story", subtask: false },
                { id: "2", name: "Sub-task", subtask: true },
              ],
            },
          };
        case "/rest/api/3/search/jql":
          expect(body).toMatchObject({
            jql: 'project = "ABC" AND (sprint in openSprints() OR sprint in futureSprints())',
            fields: ["customfield_10020"],
          });
          return {
            status: 200,
            body: {
              issues: [
                {
                  id: "1",
                  key: "ABC-1",
                  fields: { customfield_10020: [sprint(7, "closed"), sprint(8, "active")] },
                },
                {
                  id: "2",
                  key: "ABC-2",
                  fields: { customfield_10020: [sprint(8, "active"), sprint(9, "future")] },
                },
              ],
            },
          };
        default:
          return { status: 404, body: null };
      }
    });
    return run(
      config,
      people.client,
      Effect.gen(function* () {
        yield* storeToken(ALICE, "alice");
        const service = yield* JiraService.JiraService;
        const meta = yield* service.createMeta(
          { site: "acme.atlassian.net", projectKey: "ABC" },
          { actingUserId: ALICE },
        );
        expect(meta).toEqual({
          issueTypes: [
            { id: "1", name: "Story", subtask: false },
            { id: "2", name: "Sub-task", subtask: true },
          ],
          sprints: [
            { id: 8, name: "Sprint 8", state: "active" },
            { id: 9, name: "Sprint 9", state: "future" },
          ],
        });
        const reads = people.requests.filter((request) => request.url.includes("createmeta"));
        expect(reads.map((request) => request.authorization)).toEqual([basic("alice")]);
      }),
    );
  },
);

/** Jira for direct writes: Alice's token is accepted, and ABC-1 offers only transition 31. */
const makeWritableJira = () =>
  makeJira((path, body, authorization) => {
    if (path === "/_edge/tenant_info") return { status: 200, body: { cloudId: "cloud-1" } };
    if (authorization !== basic("alice") && authorization !== "Bearer secret-token") {
      return { status: 401, body: null };
    }
    switch (path) {
      case "/rest/api/3/myself":
        return { status: 200, body: { accountId: "acc-alice", displayName: "alice" } };
      case "/rest/api/3/field":
        return { status: 200, body: FIELDS };
      case "/rest/api/3/issue/ABC-1":
        return { status: 200, body: issue("ABC-1") };
      case "/rest/api/3/issue/ABC-1/comment":
        return body === undefined
          ? { status: 200, body: { comments: [], total: 0 } }
          : {
              status: 201,
              body: {
                id: "10001",
                author: { accountId: "acc-alice", displayName: "alice" },
                body: (body as { readonly body: unknown }).body,
                created: "2026-10-14T09:00:00.000+0000",
              },
            };
      case "/rest/api/3/issue/ABC-1/transitions":
        return body === undefined
          ? { status: 200, body: { transitions: [{ id: "31", name: "Done" }] } }
          : { status: 200, body: null };
      default:
        return { status: 404, body: null };
    }
  });

const writes = (requests: ReadonlyArray<Recorded>) =>
  requests.filter((request) => request.method !== "GET");

it.effect("refuses direct writes without the caller's own token, before asking Jira", () => {
  const jira = makeWritableJira();
  return run(
    config,
    jira.client,
    Effect.gen(function* () {
      const service = yield* JiraService.JiraService;
      const comment = { site: SITE, key: "ABC-1", body: "Looks good" };
      const transition = { site: SITE, key: "ABC-1", transitionId: "31" };
      for (const error of [
        yield* service.addComment(ALICE, comment).pipe(Effect.flip),
        yield* service.transitionIssue(ALICE, transition).pipe(Effect.flip),
      ]) {
        expect(error).toMatchObject({
          reason: "personal-token-required",
          message:
            "Add your Jira token in Settings → Account to comment or move issues as yourself.",
        });
      }
      expect((yield* service.addComment(undefined, comment).pipe(Effect.flip)).reason).toBe(
        "forbidden",
      );
      expect(jira.requests).toEqual([]);
    }),
  );
});

it.effect("comments as the caller and has their next issue read ask Jira again", () => {
  const jira = makeWritableJira();
  return run(
    config,
    jira.client,
    Effect.gen(function* () {
      yield* storeToken(ALICE, "alice");
      const service = yield* JiraService.JiraService;
      const issueReads = () =>
        jira.requests.filter((request) => new URL(request.url).pathname.endsWith("/issue/ABC-1"))
          .length;
      const read = { site: SITE, key: "ABC-1" };
      yield* service.issue(read, { actingUserId: ALICE });
      yield* service.issue(read, { actingUserId: ALICE });
      expect(issueReads()).toBe(1);

      const comment = yield* service.addComment(ALICE, { ...read, body: "Looks **good**" });
      expect(comment).toMatchObject({
        id: "10001",
        author: { accountId: "acc-alice" },
        body: "Looks **good**",
      });
      const [posted] = writes(jira.requests);
      expect(posted).toMatchObject({
        url: "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/ABC-1/comment",
        authorization: basic("alice"),
        body: { body: { type: "doc", version: 1 } },
      });
      expect(writes(jira.requests)).toHaveLength(1);

      yield* service.issue(read, { actingUserId: ALICE });
      expect(issueReads()).toBe(2);
    }),
  );
});

it.effect("takes a transition as the caller only while the issue still offers it", () => {
  const jira = makeWritableJira();
  return run(
    config,
    jira.client,
    Effect.gen(function* () {
      yield* storeToken(ALICE, "alice");
      const service = yield* JiraService.JiraService;
      const input = { site: SITE, key: "ABC-1" };

      const gone = yield* service
        .transitionIssue(ALICE, { ...input, transitionId: "41" })
        .pipe(Effect.flip);
      expect(gone).toMatchObject({
        reason: "invalid",
        message: "That transition is no longer available on ABC-1.",
      });
      expect(writes(jira.requests)).toEqual([]);

      yield* service.transitionIssue(ALICE, { ...input, transitionId: "31" });
      expect(writes(jira.requests)).toMatchObject([
        {
          url: "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/ABC-1/transitions",
          authorization: basic("alice"),
          body: { transition: { id: "31" } },
        },
      ]);
      const reads = jira.requests.filter((request) => request.url.endsWith("/transitions"));
      expect(reads.every((request) => request.authorization === basic("alice"))).toBe(true);
    }),
  );
});

it.effect("reads a watched issue's newest comments as the service identity, never cached", () => {
  const jira = makeJira((path, _body, authorization) => {
    // Alice's token only verifies; the watch must never read with it.
    if (path === "/_edge/tenant_info") return { status: 200, body: { cloudId: "cloud-1" } };
    if (authorization === basic("alice") && path === "/rest/api/3/myself") {
      return { status: 200, body: { accountId: "acc-alice", displayName: "Alice" } };
    }
    if (authorization !== "Bearer secret-token") return { status: 401, body: null };
    switch (path) {
      case "/rest/api/3/myself":
        return { status: 200, body: { accountId: "acc-bot", displayName: "Bot" } };
      case "/rest/api/3/issue/ABC-1/comment":
        return {
          status: 200,
          body: {
            total: 1,
            comments: [
              {
                id: "100",
                author: { accountId: "acc-ada", displayName: "Ada" },
                created: "2026-10-14T10:00:00.000+0000",
              },
            ],
          },
        };
      default:
        return { status: 404, body: null };
    }
  });
  return run(
    config,
    jira.client,
    Effect.gen(function* () {
      const service = yield* JiraService.JiraService;
      yield* storeToken(ALICE, "alice");
      const read = yield* service.watchComments(SITE, "ABC-1");
      expect(read.readerAccountId).toBe("acc-bot");
      expect(read.comments.map((comment) => [comment.id, comment.author?.accountId])).toEqual([
        ["100", "acc-ada"],
      ]);
      yield* service.watchComments(SITE, "ABC-1");
      const commentReads = jira.requests.filter((request) =>
        new URL(request.url).pathname.endsWith("/issue/ABC-1/comment"),
      );
      expect(commentReads).toHaveLength(2);
      expect(new Set(commentReads.map((request) => request.authorization))).toEqual(
        new Set(["Bearer secret-token"]),
      );
    }),
  );
});
