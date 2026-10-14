import { expect, it } from "@effect/vitest";
import { AuthUserId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
const input = { email: "me@acme.test", token: "my-token" };
const ME = { accountId: "acc-1", displayName: "Me", avatarUrls: { "48x48": "https://a/me.png" } };

interface Recorded {
  readonly url: string;
  readonly authorization: string | undefined;
}

/**
 * A fake Jira: tenant info for every site (or `tenantStatus`), `myself` answered per base URL as
 * the account named by the token. `beforeMyself` can hold a `myself` request.
 */
const makeJira = (
  myself: (base: "gateway" | "site") => number,
  options: {
    readonly tenantStatus?: number;
    readonly beforeMyself?: (authorization: string | undefined) => Effect.Effect<void>;
  } = {},
) => {
  const requests: Array<Recorded> = [];
  const headers: Array<Record<string, string>> = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      requests.push({ url: request.url, authorization: request.headers.authorization });
      headers.push({ ...request.headers });
      const url = new URL(request.url);
      if (url.pathname !== "/_edge/tenant_info") {
        yield* options.beforeMyself?.(request.headers.authorization) ?? Effect.void;
      }
      const answer =
        url.pathname === "/_edge/tenant_info"
          ? (options.tenantStatus ?? 200) === 200
            ? { status: 200, body: { cloudId: "cloud-1" } }
            : { status: options.tenantStatus ?? 500, body: null }
          : (() => {
              const status = myself(url.host === "api.atlassian.com" ? "gateway" : "site");
              const account = Buffer.from(
                (request.headers.authorization ?? "").replace("Basic ", ""),
                "base64",
              )
                .toString()
                .split(":")[0];
              return {
                status,
                body:
                  status === 200
                    ? { ...ME, accountId: account === input.email ? ME.accountId : account }
                    : { errorMessages: [status === 403 ? "Missing scope read:jira-user." : "No"] },
              };
            })();
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(answer.body), { status: answer.status }),
      );
    }),
  );
  return { requests, headers, client };
};

const makeSecretStore = () => {
  const entries = new Map<string, Uint8Array>();
  const reads = { count: 0 };
  const store = ServerSecretStore.ServerSecretStore.of({
    get: (name) =>
      Effect.sync(() => {
        reads.count++;
        return Option.fromNullishOr(entries.get(name));
      }),
    set: (name, value) => Effect.sync(() => void entries.set(name, value)),
    create: (name, value) => Effect.sync(() => void entries.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void entries.delete(name)),
  });
  return { entries, reads, store };
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
      // Jira would otherwise translate names into the account's profile language.
      expect(jira.headers.map((headers) => headers["accept-language"])).toEqual(["en", "en"]);
      expect(jira.headers[1]?.["x-force-accept-language"]).toBe("true");
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

it.effect("surfaces a gateway refusal other than 401 without trying the site", () => {
  const jira = makeJira((base) => (base === "gateway" ? 403 : 200));
  const secrets = makeSecretStore();
  return run(
    jira,
    secrets,
    Effect.gen(function* () {
      const credentials = yield* JiraUserCredentials.JiraUserCredentials;
      const error = yield* credentials.set(USER, input).pipe(Effect.flip);
      expect(error).toMatchObject({
        reason: "forbidden",
        message: "Missing scope read:jira-user.",
      });
      expect(jira.requests.map((request) => request.url).slice(1)).toEqual([
        `${GATEWAY}/rest/api/3/myself`,
      ]);
      expect(secrets.entries.size).toBe(0);
    }),
  );
});

it.effect("verifies on the site when the cloud id cannot be read", () => {
  const jira = makeJira(() => 200, { tenantStatus: 503 });
  const secrets = makeSecretStore();
  return run(
    jira,
    secrets,
    Effect.gen(function* () {
      const credentials = yield* JiraUserCredentials.JiraUserCredentials;
      expect((yield* credentials.set(USER, input)).error).toBeNull();
      expect(jira.requests.map((request) => request.url).slice(1)).toEqual([
        `https://${SITE}/rest/api/3/myself`,
      ]);
      expect(yield* storedRows).toEqual([{ user_id: USER, cloud_id: null, last_error: null }]);
    }),
  );
});

it.effect("a credential whose secret is gone fails reads instead of using the reader", () => {
  const jira = makeJira(() => 200);
  const secrets = makeSecretStore();
  return run(
    jira,
    secrets,
    Effect.gen(function* () {
      const credentials = yield* JiraUserCredentials.JiraUserCredentials;
      yield* credentials.set(USER, input);
      secrets.entries.delete(SECRET);

      const error = yield* credentials.identityFor(USER, SITE).pipe(Effect.flip);
      expect(error.reason).toBe("unauthorized");
      expect(error.message).toContain("Settings → Account");
      expect((yield* credentials.get(USER))?.error).toBe(error.message);
      expect(yield* storedRows).toEqual([
        { user_id: USER, cloud_id: "cloud-1", last_error: error.message },
      ]);
      expect((yield* credentials.test(USER)).error).toBe(error.message);
    }),
  );
});

it.effect("resolves a user's identity once until their credential changes", () => {
  const jira = makeJira(() => 200);
  const secrets = makeSecretStore();
  return run(
    jira,
    secrets,
    Effect.gen(function* () {
      const credentials = yield* JiraUserCredentials.JiraUserCredentials;
      yield* credentials.set(USER, input);
      yield* credentials.identityFor(USER, SITE);
      const reads = secrets.reads.count;
      yield* credentials.identityFor(USER, SITE);
      yield* credentials.get(USER);
      expect(secrets.reads.count).toBe(reads);

      yield* credentials.clear(USER);
      expect(yield* credentials.identityFor(USER, SITE)).toBeUndefined();
      expect(yield* credentials.get(USER)).toBeNull();
    }),
  );
});

it.effect("serializes concurrent changes to one user's token", () =>
  Effect.gen(function* () {
    const firstArrived = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const first = { email: "first@acme.test", token: "first-token" };
    const second = { email: "second@acme.test", token: "second-token" };
    const firstAuthorization = `Basic ${Buffer.from("first@acme.test:first-token").toString("base64")}`;
    const jira = makeJira(() => 200, {
      beforeMyself: (authorization) =>
        authorization === firstAuthorization
          ? Deferred.succeed(firstArrived, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
            )
          : Effect.void,
    });
    const secrets = makeSecretStore();
    yield* run(
      jira,
      secrets,
      Effect.gen(function* () {
        const credentials = yield* JiraUserCredentials.JiraUserCredentials;
        const firstSet = yield* Effect.forkChild(credentials.set(USER, first));
        yield* Deferred.await(firstArrived);
        const secondSet = yield* Effect.forkChild(credentials.set(USER, second));
        yield* Effect.yieldNow;
        // The second request waits for the first instead of asking Jira alongside it.
        expect(jira.requests.length).toBe(2);
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(firstSet);
        yield* Fiber.join(secondSet);

        // The later request owns both the secret and the row.
        expect(JSON.parse(new TextDecoder().decode(secrets.entries.get(SECRET)))).toEqual(second);
        expect((yield* credentials.get(USER))?.account?.accountId).toBe(second.email);
      }),
    );
  }),
);
