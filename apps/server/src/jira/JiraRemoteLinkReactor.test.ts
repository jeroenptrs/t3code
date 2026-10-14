import { assert, it } from "@effect/vitest";
import { EnvironmentId, JiraError, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
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

/** A Jira that records remote link writes and refuses them on `forbiddenSites`. */
const makeJira = () => {
  const writes: Array<Write> = [];
  const forbiddenSites = new Set<string>();
  const answer = (site: string, write: Write) =>
    Effect.suspend(() => {
      if (forbiddenSites.has(site)) {
        return Effect.fail(new JiraError({ reason: "forbidden", message: "No." }));
      }
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
  return { writes, forbiddenSites, layer };
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

const layerTest = (jira: ReturnType<typeof makeJira>, publicUrl: string | null = ORIGIN) =>
  JiraRemoteLinkReactor.layer.pipe(
    Layer.provide(jira.layer),
    Layer.provide(Layer.succeed(JiraIdentities.JiraIdentities, JiraIdentities.make(jiraConfig))),
    Layer.provide(configWith(publicUrl)),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("env-1")),
      }),
    ),
    Layer.provideMerge(layerOrchestration("jira-remote-links")),
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

it.effect("leaves a site that refuses the writes alone for an hour, failing nothing", () => {
  const jira = makeJira();
  jira.forbiddenSites.add(SITE);
  return Effect.gen(function* () {
    const reactor = yield* JiraRemoteLinkReactor.JiraRemoteLinkReactor;
    yield* createThread(one);
    yield* linkIssue(one, "ABC-1", "manual");
    yield* linkIssue(one, "XYZ-1", "manual", OTHER_SITE);
    yield* createThread(two);
    yield* linkIssue(two, "ABC-2", "manual");

    yield* reactor.reconcile;
    assert.deepStrictEqual(
      jira.writes.map((write) => write.key),
      ["XYZ-1"],
    );

    // Paused: the site is not asked again, even once it would accept.
    jira.forbiddenSites.delete(SITE);
    yield* reactor.reconcile;
    assert.lengthOf(jira.writes, 1);

    yield* TestClock.adjust("1 hour");
    yield* reactor.reconcile;
    assert.deepStrictEqual(
      jira.writes
        .slice(1)
        .map((write) => write.key)
        .toSorted(),
      ["ABC-1", "ABC-2"],
    );
  }).pipe(Effect.provide(layerTest(jira)));
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
