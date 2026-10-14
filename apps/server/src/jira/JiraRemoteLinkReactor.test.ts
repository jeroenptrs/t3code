import { assert, it } from "@effect/vitest";
import { EnvironmentId, JiraError, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as JiraApi from "./JiraApi.ts";
import * as JiraIdentities from "./JiraIdentities.ts";
import {
  OTHER_SITE,
  SITE,
  archiveThread,
  createThread,
  deleteThread,
  jiraConfig,
  layerOrchestration,
  linkIssue,
  unlinkIssue,
} from "./JiraLinks.testkit.ts";
import * as JiraRemoteLinkReactor from "./JiraRemoteLinkReactor.ts";

const ORIGIN = "https://t3.example.com";

interface Write {
  readonly op: "upsert" | "delete";
  readonly identity: string;
  readonly key: string;
  readonly globalId: string;
  readonly url?: string;
  readonly title?: string;
}

/**
 * A Jira that records every remote link request in `attempts` and the ones it took in `writes`.
 * `refusals` fails a request by `site/KEY`, by `site/PROJECT` or by site.
 */
const makeJira = () => {
  const writes: Array<Write> = [];
  const attempts: Array<Write> = [];
  const refusals = new Map<string, JiraError["reason"]>();
  const answer = (site: string, write: Write) =>
    Effect.suspend(() => {
      attempts.push(write);
      const reason =
        refusals.get(`${site}/${write.key}`) ??
        refusals.get(`${site}/${write.key.split("-")[0]}`) ??
        refusals.get(site);
      if (reason !== undefined) return Effect.fail(new JiraError({ reason, message: "No." }));
      writes.push(write);
      return Effect.void;
    });
  const layer = Layer.mock(JiraApi.JiraApi)({
    upsertRemoteLink: (identity, key, link) =>
      answer(identity.site, {
        op: "upsert",
        identity: identity.name,
        key,
        globalId: link.globalId,
        url: link.url,
        title: link.title,
      }),
    deleteRemoteLink: (identity, key, globalId) =>
      answer(identity.site, { op: "delete", identity: identity.name, key, globalId }),
  });
  return { writes, attempts, refusals, layer };
};

const configWith = (publicUrl: string | null) =>
  Layer.succeed(ServerConfig.ServerConfig, {
    // Only the public URL is read here.
    entraSignIn:
      publicUrl === null
        ? undefined
        : {
            tenantId: "tenant",
            clientId: "client",
            clientSecret: Redacted.make("secret"),
            publicUrl: new URL(publicUrl),
            callbackPath: ServerConfig.DEFAULT_ENTRA_CALLBACK_PATH,
          },
  } as unknown as ServerConfig.ServerConfig["Service"]);

const layerReactor = (jira: ReturnType<typeof makeJira>, publicUrl: string | null = ORIGIN) =>
  JiraRemoteLinkReactor.layer.pipe(
    Layer.provide(jira.layer),
    Layer.provide(Layer.succeed(JiraIdentities.JiraIdentities, JiraIdentities.make(jiraConfig))),
    Layer.provide(configWith(publicUrl)),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("env-1")),
      }),
    ),
  );

const layerTest = (jira: ReturnType<typeof makeJira>, publicUrl: string | null = ORIGIN) =>
  layerReactor(jira, publicUrl).pipe(Layer.provideMerge(layerOrchestration("jira-remote-links")));

/** A second reactor on the same database, as after a server restart. */
const restartedReactor = (jira: ReturnType<typeof makeJira>) =>
  Layer.build(layerReactor(jira)).pipe(
    Effect.map((context) => Context.get(context, JiraRemoteLinkReactor.JiraRemoteLinkReactor)),
  );

const writtenRows = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql<{ readonly key: string; readonly threadId: string }>`
    SELECT issue_key AS key, thread_id AS "threadId" FROM fork_jira_remote_links
    ORDER BY issue_key, thread_id
  `.pipe(Effect.map((rows) => rows.map((row) => [row.key, row.threadId]))),
);

const one = ThreadId.make("thread:one");
const two = ThreadId.make("thread:two");
const globalId = (threadId: ThreadId) => `t3code:env-1:${threadId}`;

it.effect("links each issue to the thread as the site's service identity, then unlinks", () => {
  const jira = makeJira();
  return Effect.gen(function* () {
    const reactor = yield* JiraRemoteLinkReactor.JiraRemoteLinkReactor;
    yield* createThread(one);
    yield* linkIssue(one, "ABC-1", "manual");
    yield* linkIssue(one, "XYZ-1", "agent", OTHER_SITE);
    // A dismissed branch link is a tombstone, not a link.
    yield* createThread(two);
    yield* linkIssue(two, "ABC-2", "branch");
    yield* unlinkIssue(two, "ABC-2");

    yield* reactor.reconcile;
    assert.deepStrictEqual(
      jira.writes.toSorted((left, right) => left.key.localeCompare(right.key)),
      [
        {
          op: "upsert",
          identity: "bot",
          key: "ABC-1",
          globalId: globalId(one),
          url: `${ORIGIN}/env-1/thread%3Aone`,
          title: "T3 Code: Started",
        },
        {
          op: "upsert",
          identity: "beta",
          key: "XYZ-1",
          globalId: globalId(one),
          url: `${ORIGIN}/env-1/thread%3Aone`,
          title: "T3 Code: Started",
        },
      ],
    );

    // Nothing changed, so nothing is written again.
    yield* reactor.reconcile;
    assert.lengthOf(jira.writes, 2);

    yield* unlinkIssue(one, "ABC-1");
    yield* reactor.reconcile;
    assert.deepStrictEqual(jira.writes.slice(2), [
      { op: "delete", identity: "bot", key: "ABC-1", globalId: globalId(one) },
    ]);
  }).pipe(Effect.provide(layerTest(jira)));
});

it.effect("removes the links of a thread once it is archived", () => {
  const jira = makeJira();
  return Effect.gen(function* () {
    const reactor = yield* JiraRemoteLinkReactor.JiraRemoteLinkReactor;
    yield* createThread(one);
    yield* linkIssue(one, "ABC-1", "manual");
    yield* reactor.reconcile;
    assert.lengthOf(jira.writes, 1);

    yield* archiveThread(one);
    yield* reactor.reconcile;
    assert.deepStrictEqual(jira.writes.slice(1), [
      { op: "delete", identity: "bot", key: "ABC-1", globalId: globalId(one) },
    ]);
  }).pipe(Effect.provide(layerTest(jira)));
});

it.effect("leaves a project that refuses the writes alone for an hour, failing nothing", () => {
  const jira = makeJira();
  jira.refusals.set(`${SITE}/ABC`, "forbidden");
  return Effect.gen(function* () {
    const reactor = yield* JiraRemoteLinkReactor.JiraRemoteLinkReactor;
    // One thread's links are written in turn, so the refusal is seen before ABC-2 is asked.
    yield* createThread(one);
    yield* linkIssue(one, "ABC-1", "manual");
    yield* linkIssue(one, "ABC-2", "manual");
    // Another project on the same site still takes links.
    yield* linkIssue(one, "DEF-1", "manual");
    yield* createThread(two);
    yield* linkIssue(two, "XYZ-1", "manual", OTHER_SITE);

    yield* reactor.reconcile;
    assert.deepStrictEqual(jira.writes.map((write) => write.key).toSorted(), ["DEF-1", "XYZ-1"]);
    assert.lengthOf(
      jira.attempts.filter((attempt) => attempt.key.startsWith("ABC-")),
      1,
    );

    // Paused: the project is not asked again, even once it would accept.
    jira.refusals.clear();
    yield* reactor.reconcile;
    assert.lengthOf(jira.writes, 2);

    yield* TestClock.adjust("1 hour");
    yield* reactor.reconcile;
    assert.deepStrictEqual(
      jira.writes
        .slice(2)
        .map((write) => write.key)
        .toSorted(),
      ["ABC-1", "ABC-2"],
    );
  }).pipe(Effect.provide(layerTest(jira)));
});

it.effect("leaves a whole site alone for an hour when Jira rejects its credentials", () => {
  const jira = makeJira();
  jira.refusals.set(`${SITE}/ABC-1`, "unauthorized");
  return Effect.gen(function* () {
    const reactor = yield* JiraRemoteLinkReactor.JiraRemoteLinkReactor;
    yield* createThread(one);
    yield* linkIssue(one, "ABC-1", "manual");
    yield* linkIssue(one, "DEF-1", "manual");
    yield* createThread(two);
    yield* linkIssue(two, "XYZ-1", "manual", OTHER_SITE);

    yield* reactor.reconcile;
    assert.deepStrictEqual(
      jira.writes.map((write) => write.key),
      ["XYZ-1"],
    );
    jira.refusals.clear();
    yield* reactor.reconcile;
    assert.lengthOf(jira.writes, 1);
    yield* TestClock.adjust("1 hour");
    yield* reactor.reconcile;
    assert.deepStrictEqual(
      jira.writes
        .slice(1)
        .map((write) => write.key)
        .toSorted(),
      ["ABC-1", "DEF-1"],
    );
  }).pipe(Effect.provide(layerTest(jira)));
});

it.effect("tries an issue the identity cannot see again on the next pass", () => {
  const jira = makeJira();
  jira.refusals.set(`${SITE}/ABC-1`, "not-found");
  return Effect.gen(function* () {
    const reactor = yield* JiraRemoteLinkReactor.JiraRemoteLinkReactor;
    yield* createThread(one);
    yield* linkIssue(one, "ABC-1", "manual");
    yield* reactor.reconcile;
    assert.deepStrictEqual(jira.writes, []);
    assert.deepStrictEqual(yield* writtenRows, []);

    jira.refusals.clear();
    yield* reactor.reconcile;
    assert.deepStrictEqual(
      jira.writes.map((write) => [write.op, write.key]),
      [["upsert", "ABC-1"]],
    );
    assert.deepStrictEqual(yield* writtenRows, [["ABC-1", one]]);
  }).pipe(Effect.provide(layerTest(jira)));
});

it.effect("removes after a restart the links of threads that went away while it was down", () => {
  const jira = makeJira();
  return Effect.gen(function* () {
    const reactor = yield* JiraRemoteLinkReactor.JiraRemoteLinkReactor;
    yield* createThread(one);
    yield* linkIssue(one, "ABC-1", "manual");
    yield* createThread(two);
    yield* linkIssue(two, "ABC-2", "manual");
    yield* linkIssue(two, "ABC-3", "manual");
    yield* reactor.reconcile;
    assert.deepStrictEqual(yield* writtenRows, [
      ["ABC-1", one],
      ["ABC-2", two],
      ["ABC-3", two],
    ]);

    // While the server is down, one thread is deleted and another unlinks an issue.
    yield* deleteThread(one);
    yield* unlinkIssue(two, "ABC-3");
    const restarted = yield* restartedReactor(jira);
    // A delete Jira does not confirm keeps its row for the next pass.
    jira.refusals.set(`${SITE}/ABC-1`, "unavailable");
    yield* restarted.reconcile;
    assert.deepStrictEqual(
      jira.writes.slice(3).map((write) => [write.op, write.key, write.globalId]),
      [["delete", "ABC-3", globalId(two)]],
    );
    assert.deepStrictEqual(yield* writtenRows, [
      ["ABC-1", one],
      ["ABC-2", two],
    ]);

    // A link Jira no longer has counts as removed.
    jira.refusals.set(`${SITE}/ABC-1`, "not-found");
    yield* restarted.reconcile;
    assert.deepStrictEqual(yield* writtenRows, [["ABC-2", two]]);
    // Links that were written stay as they are, without being written again.
    assert.isFalse(jira.attempts.slice(3).some((attempt) => attempt.op === "upsert"));
  }).pipe(Effect.scoped, Effect.provide(layerTest(jira)));
});

it.effect("writes nothing without a public URL to link to", () => {
  const jira = makeJira();
  return Effect.gen(function* () {
    const reactor = yield* JiraRemoteLinkReactor.JiraRemoteLinkReactor;
    yield* createThread(one);
    yield* linkIssue(one, "ABC-1", "manual");
    yield* reactor.reconcile;
    assert.deepStrictEqual(jira.writes, []);
  }).pipe(Effect.provide(layerTest(jira, null)));
});
