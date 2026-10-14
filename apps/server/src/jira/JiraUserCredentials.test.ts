import { expect, it } from "@effect/vitest";
import { AuthUserId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as JiraApi from "./JiraApi.ts";
import * as JiraIdentities from "./JiraIdentities.ts";
import { OTHER_SITE, SITE, jiraConfig } from "./JiraLinks.testkit.ts";
import * as JiraUserCredentials from "./JiraUserCredentials.ts";

const USER = AuthUserId.make("user-1");
const SECRET = `jira-user-token-${Buffer.from(USER).toString("base64url")}`;
const GATEWAY = "https://api.atlassian.com/ex/jira/cloud-1";
const BASIC = `Basic ${Buffer.from("me@acme.test:my-token").toString("base64")}`;
const ME = { accountId: "acc-1", displayName: "Me", avatarUrls: { "48x48": "https://a/me.png" } };

interface Recorded {
  readonly url: string;
  readonly authorization: string | undefined;
}

/** A fake Jira: tenant info for every site, `myself` answered per base URL. */
const makeJira = (myself: (base: "gateway" | "site") => number) => {
  const requests: Array<Recorded> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({ url: request.url, authorization: request.headers.authorization });
      const url = new URL(request.url);
      const answer =
        url.pathname === "/_edge/tenant_info"
          ? { status: 200, body: { cloudId: "cloud-1" } }
          : (() => {
              const status = myself(url.host === "api.atlassian.com" ? "gateway" : "site");
              return { status, body: status === 200 ? ME : { errorMessages: ["No"] } };
            })();
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(answer.body), { status: answer.status }),
      );
    }),
  );
  return { requests, client };
};

const makeSecretStore = () => {
  const entries = new Map<string, Uint8Array>();
  const store = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(entries.get(name))),
    set: (name, value) => Effect.sync(() => void entries.set(name, value)),
    create: (name, value) => Effect.sync(() => void entries.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void entries.delete(name)),
  });
  return { entries, store };
};

const run = <A, E>(
  jira: ReturnType<typeof makeJira>,
  secrets: ReturnType<typeof makeSecretStore>,
  effect: Effect.Effect<A, E, JiraUserCredentials.JiraUserCredentials | SqlClient.SqlClient>,
) =>
  effect.pipe(
    Effect.provide(
      JiraUserCredentials.layer.pipe(
        Layer.provide(JiraApi.layer),
        Layer.provide(
          Layer.succeed(JiraIdentities.JiraIdentities, JiraIdentities.make(jiraConfig)),
        ),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, jira.client)),
        Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.store)),
        Layer.provideMerge(SqlitePersistence.layerMemory),
      ),
    ),
  );

const input = { email: "me@acme.test", token: "my-token" };

const storedRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT user_id, cloud_id, last_error FROM fork_jira_user_credentials`;
});

it.effect("stores a token the gateway accepts, verified as the user", () => {
  const jira = makeJira(() => 200);
  const secrets = makeSecretStore();
  return run(
    jira,
    secrets,
    Effect.gen(function* () {
      const credentials = yield* JiraUserCredentials.JiraUserCredentials;
      const credential = yield* credentials.set(USER, input);
      expect(credential).toMatchObject({
        site: SITE,
        account: { accountId: "acc-1", displayName: "Me", avatarUrl: "https://a/me.png" },
        error: null,
      });
      expect(credential.lastVerifiedAt).toBe(credential.createdAt);
      expect(jira.requests).toEqual([
        { url: `https://${SITE}/_edge/tenant_info`, authorization: undefined },
        { url: `${GATEWAY}/rest/api/3/myself`, authorization: BASIC },
      ]);
      expect(JSON.parse(new TextDecoder().decode(secrets.entries.get(SECRET)))).toEqual(input);
      expect(yield* storedRows).toEqual([{ user_id: USER, cloud_id: "cloud-1", last_error: null }]);
      expect(yield* credentials.get(USER)).toEqual(credential);

      const identity = yield* credentials.identityFor(USER, SITE);
      expect(identity).toMatchObject({ site: SITE, authMethod: "basic", cloudId: "cloud-1" });
      expect(identity && Redacted.value(identity.token)).toBe("my-token");
      expect(yield* credentials.identityFor(USER, OTHER_SITE)).toBeUndefined();
    }),
  );
});

it.effect("falls back to the site for a classic token", () => {
  const jira = makeJira((base) => (base === "gateway" ? 401 : 200));
  const secrets = makeSecretStore();
  return run(
    jira,
    secrets,
    Effect.gen(function* () {
      const credentials = yield* JiraUserCredentials.JiraUserCredentials;
      yield* credentials.set(USER, input);
      expect(jira.requests.map((request) => request.url).slice(1)).toEqual([
        `${GATEWAY}/rest/api/3/myself`,
        `https://${SITE}/rest/api/3/myself`,
      ]);
      expect(yield* storedRows).toEqual([{ user_id: USER, cloud_id: null, last_error: null }]);
      const identity = yield* credentials.identityFor(USER, SITE);
      expect(identity?.cloudId).toBeUndefined();
    }),
  );
});

it.effect("stores nothing when Jira rejects the token, or for a site it does not serve", () => {
  const jira = makeJira(() => 401);
  const secrets = makeSecretStore();
  return run(
    jira,
    secrets,
    Effect.gen(function* () {
      const credentials = yield* JiraUserCredentials.JiraUserCredentials;
      const rejected = yield* credentials.set(USER, input).pipe(Effect.flip);
      expect(rejected.reason).toBe("unauthorized");
      const elsewhere = yield* credentials
        .set(USER, { ...input, site: "other.atlassian.net" })
        .pipe(Effect.flip);
      expect(elsewhere.reason).toBe("invalid");
      expect(secrets.entries.size).toBe(0);
      expect(yield* storedRows).toEqual([]);
      expect(yield* credentials.get(USER)).toBeNull();
    }),
  );
});

it.effect("replacing a token gives the user a new identity", () => {
  const jira = makeJira(() => 200);
  const secrets = makeSecretStore();
  return run(
    jira,
    secrets,
    Effect.gen(function* () {
      const credentials = yield* JiraUserCredentials.JiraUserCredentials;
      yield* credentials.set(USER, input);
      const before = yield* credentials.identityFor(USER, SITE);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* credentials.set(USER, { ...input, token: "new-token" });
      const after = yield* credentials.identityFor(USER, SITE);
      expect(after?.name).not.toBe(before?.name);
      expect(after && Redacted.value(after.token)).toBe("new-token");
      expect((yield* storedRows).length).toBe(1);
    }),
  );
});

it.effect("test records a refusal, and clear removes the token", () => {
  let status = 200;
  const jira = makeJira(() => status);
  const secrets = makeSecretStore();
  return run(
    jira,
    secrets,
    Effect.gen(function* () {
      const credentials = yield* JiraUserCredentials.JiraUserCredentials;
      yield* credentials.set(USER, input);
      status = 401;
      const refused = yield* credentials.test(USER);
      expect(refused.error).toBe("Jira rejected your personal Jira token.");
      expect((yield* credentials.get(USER))?.error).toBe(refused.error);
      status = 200;
      expect((yield* credentials.test(USER)).error).toBeNull();

      yield* credentials.clear(USER);
      expect(secrets.entries.size).toBe(0);
      expect(yield* storedRows).toEqual([]);
      expect((yield* credentials.test(USER).pipe(Effect.flip)).reason).toBe("not-found");
      yield* credentials.clear(USER);
    }),
  );
});

it.effect("refuses a session without a portal user", () => {
  const jira = makeJira(() => 200);
  const secrets = makeSecretStore();
  return run(
    jira,
    secrets,
    Effect.gen(function* () {
      const credentials = yield* JiraUserCredentials.JiraUserCredentials;
      for (const attempt of [
        credentials.set(undefined, input),
        credentials.test(undefined),
        credentials.clear(undefined),
      ]) {
        const error = yield* Effect.flip(attempt);
        expect(error.reason).toBe("forbidden");
        expect(error.message).toContain("organisation account");
      }
      expect(jira.requests).toEqual([]);
    }),
  );
});
