import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient, HttpClientResponse } from "effect/http";

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

/** A fake Jira answering by path; every request is recorded. */
const makeJira = (respond: (path: string, body: unknown) => { status: number; body: unknown }) => {
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
      const answer = respond(path, body);
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(answer.body), { status: answer.status }),
      );
    }),
  );
  return { requests, client };
};

const serviceLayer = (jiraConfig: JiraConfig | undefined, client: HttpClient.HttpClient) =>
  JiraService.layer.pipe(
    Layer.provide(JiraApi.layer),
    Layer.provide(JiraReadCache.layer),
    Layer.provide(Layer.succeed(JiraIdentities.JiraIdentities, JiraIdentities.make(jiraConfig))),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const run = <A, E>(
  jiraConfig: JiraConfig | undefined,
  client: HttpClient.HttpClient,
  effect: Effect.Effect<A, E, JiraService.JiraService | SqlClient.SqlClient>,
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

      const both = yield* service.search({ filterId: "10000", jql: "x" }).pipe(Effect.flip);
      expect(both.reason).toBe("invalid");
      expect((yield* service.search({}).pipe(Effect.flip)).reason).toBe("invalid");
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
