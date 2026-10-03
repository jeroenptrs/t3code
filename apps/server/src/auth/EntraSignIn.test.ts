import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  EnvironmentHttpApi,
  type AuthUserIdentity,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EntraSignIn from "./EntraSignIn.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import * as UserRegistry from "./UserRegistry.ts";
import {
  authHttpApiLayer,
  entraSignInRouteLayer,
  environmentAuthenticatedAuthLayer,
} from "./http.ts";

const TENANT = "8f2c3a1e-1b2c-4d5e-8f90-123456789abc";
const OTHER_TENANT = "0a0b0c0d-1b2c-4d5e-8f90-123456789abc";
const CLIENT_ID = "11111111-2222-4333-8444-555555555555";
const CLIENT_SECRET = "entra-client-secret";
const PUBLIC_URL = "https://t3.example.com";
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const hostCli = { type: "host-cli" } as const;

const objectId = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const identity = (suffix: string): AuthUserIdentity => ({
  tenantId: TENANT,
  objectId: objectId(suffix),
});

// ---------------------------------------------------------------------------
// An in-process Entra tenant: signs ID tokens, serves its keys, and redeems
// each authorization code once, only with the PKCE verifier it was issued for.
// ---------------------------------------------------------------------------

const tenantKey = await generateKeyPair("RS256");
const strangerKey = await generateKeyPair("RS256");
const rotatedKey = await generateKeyPair("RS256");
const publicJwk = { ...(await exportJWK(tenantKey.publicKey)), kid: "tenant-key", alg: "RS256" };
const rotatedJwk = {
  ...(await exportJWK(rotatedKey.publicKey)),
  kid: "rotated-key",
  alg: "RS256",
};
/** The keys the fake tenant publishes right now. */
let publishedKeys: ReadonlyArray<typeof publicJwk> = [publicJwk];
const issuedCodes = new Map<string, { readonly idToken: string; readonly challenge: string }>();
let codeCounter = 0;

const signIdToken = (
  claims: JWTPayload,
  options?: {
    readonly issuer?: string;
    readonly audience?: string;
    readonly expiresAt?: number;
    readonly key?: "tenant" | "stranger" | "rotated";
  },
) =>
  new SignJWT({ tid: TENANT, ...claims })
    .setProtectedHeader({
      alg: "RS256",
      kid: options?.key === "rotated" ? "rotated-key" : "tenant-key",
    })
    .setIssuer(options?.issuer ?? ISSUER)
    .setAudience(options?.audience ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(options?.expiresAt ?? "10m")
    .sign(
      options?.key === "stranger"
        ? strangerKey.privateKey
        : options?.key === "rotated"
          ? rotatedKey.privateKey
          : tenantKey.privateKey,
    );

const jsonResponse = (
  request: Parameters<typeof HttpClientResponse.fromWeb>[0],
  status: number,
  body: unknown,
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );

const fakeEntraHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      if (url.pathname === `/${TENANT}/discovery/v2.0/keys`) {
        return jsonResponse(request, 200, { keys: publishedKeys });
      }
      if (request.method === "POST" && url.pathname === `/${TENANT}/oauth2/v2.0/token`) {
        const form = new URLSearchParams(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        );
        const code = form.get("code") ?? "";
        const issued = issuedCodes.get(code);
        issuedCodes.delete(code);
        const verifier = form.get("code_verifier") ?? "";
        const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
        if (
          issued === undefined ||
          issued.challenge !== challenge ||
          form.get("client_id") !== CLIENT_ID ||
          form.get("client_secret") !== CLIENT_SECRET ||
          form.get("redirect_uri") !== `${PUBLIC_URL}/api/auth/entra/callback`
        ) {
          return jsonResponse(request, 400, { error: "invalid_grant", error_codes: [54005] });
        }
        return jsonResponse(request, 200, { token_type: "Bearer", id_token: issued.idToken });
      }
      return jsonResponse(request, 404, {});
    }),
  ),
);

// ---------------------------------------------------------------------------

const configLayer = (entra: boolean) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        mode: "web",
        host: "0.0.0.0",
        ...(entra
          ? {
              entraSignIn: {
                tenantId: TENANT,
                clientId: CLIENT_ID,
                clientSecret: Redacted.make(CLIENT_SECRET),
                publicUrl: new URL(PUBLIC_URL),
              },
            }
          : {}),
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-entra-test-" })));

const makeLayer = (options?: { readonly entra?: boolean }) =>
  EntraSignIn.layer.pipe(
    Layer.provideMerge(EnvironmentAuth.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.identityLayer),
    Layer.provideMerge(configLayer(options?.entra ?? true)),
    Layer.provide(fakeEntraHttpClient),
  );

type AuthRequest = Parameters<
  EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
>[0];
const cookieRequest = (cookieName: string, token: string) =>
  ({ cookies: { [cookieName]: token }, headers: {} }) as unknown as AuthRequest;
const bearerRequest = (token: string) =>
  ({ cookies: {}, headers: { authorization: `Bearer ${token}` } }) as unknown as AuthRequest;

/** Runs the whole browser round trip against the fake tenant. */
const completeSignIn = (
  claims: JWTPayload,
  options?: Parameters<typeof signIdToken>[1] & {
    readonly returnTo?: string;
    readonly tamper?: (input: {
      state: string | null;
      flowCookie: string | undefined;
      nonce: string;
    }) => { state: string | null; flowCookie: string | undefined; nonce: string };
  },
) =>
  Effect.gen(function* () {
    const entra = yield* EntraSignIn.EntraSignIn;
    const started = yield* entra.start({ returnTo: options?.returnTo ?? null });
    const authorize = new URL(started.authorizationUrl);
    const flow = (options?.tamper ?? ((input) => input))({
      state: authorize.searchParams.get("state"),
      flowCookie: started.flowCookie,
      nonce: authorize.searchParams.get("nonce") ?? "",
    });
    const code = `code-${++codeCounter}`;
    issuedCodes.set(code, {
      idToken: yield* Effect.promise(() => signIdToken({ nonce: flow.nonce, ...claims }, options)),
      challenge: authorize.searchParams.get("code_challenge") ?? "",
    });
    return yield* entra.complete({
      code,
      state: flow.state,
      error: null,
      flowCookie: flow.flowCookie,
      client: { deviceType: "desktop" },
    });
  });

const signInAs = (suffix: string, labels?: { readonly name?: string; readonly email?: string }) =>
  completeSignIn({
    oid: objectId(suffix),
    ...(labels?.name ? { name: labels.name } : {}),
    ...(labels?.email ? { preferred_username: labels.email } : {}),
  });

const expectFailure = <A, R>(
  effect: Effect.Effect<A, EntraSignIn.EntraSignInError | EntraSignIn.EntraSignInDisabledError, R>,
) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result) || result.failure._tag !== "EntraSignInError") {
      throw new Error("expected an EntraSignInError");
    }
    return result.failure.reason;
  });

it("honors only same-origin relative return paths", () => {
  expect(EntraSignIn.sanitizeReturnPath("/threads/abc?view=diff#turn-2")).toBe(
    "/threads/abc?view=diff#turn-2",
  );
  expect(EntraSignIn.sanitizeReturnPath("/a/../b")).toBe("/b");
  for (const unsafe of [
    null,
    "",
    "threads/abc",
    "https://evil.example/",
    "//evil.example/path",
    "/.//evil.example/x",
    "/a/..//evil.example",
    "/%2e//evil.example",
    "/./%2e//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/path\nwith-newline",
    "javascript:alert(1)",
    `/${"a".repeat(3000)}`,
  ]) {
    expect(EntraSignIn.sanitizeReturnPath(unsafe)).toBe("/");
  }
});

it.layer(NodeServices.layer)("EntraSignIn", (it) => {
  it.effect("starts a PKCE authorization request for the configured tenant only", () =>
    Effect.gen(function* () {
      const entra = yield* EntraSignIn.EntraSignIn;
      const started = yield* entra.start({ returnTo: "https://evil.example/" });
      const url = new URL(started.authorizationUrl);

      expect(`${url.origin}${url.pathname}`).toBe(
        `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
      );
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: `${PUBLIC_URL}/api/auth/entra/callback`,
        code_challenge_method: "S256",
      });
      expect(url.searchParams.get("code_challenge")).toBeTruthy();
      expect(started.flowCookie).not.toContain(url.searchParams.get("code_challenge"));
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("rejects callbacks whose state does not belong to this browser", () =>
    Effect.gen(function* () {
      const claims = { oid: objectId("1") };
      expect(
        yield* expectFailure(
          completeSignIn(claims, { tamper: (flow) => ({ ...flow, state: "forged" }) }),
        ),
      ).toBe("invalid_state");
      expect(
        yield* expectFailure(
          completeSignIn(claims, { tamper: (flow) => ({ ...flow, flowCookie: undefined }) }),
        ),
      ).toBe("invalid_state");
      expect(
        yield* expectFailure(
          completeSignIn(claims, {
            tamper: (flow) => ({ ...flow, flowCookie: `${flow.flowCookie}x` }),
          }),
        ),
      ).toBe("invalid_state");
      const registry = yield* UserRegistry.UserRegistry;
      expect(yield* registry.list()).toEqual([]);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect(
    "rejects ID tokens with the wrong nonce, issuer, audience, tenant, key, or expiry",
    () =>
      Effect.gen(function* () {
        const oid = objectId("1");
        // Seconds since the epoch, long past: jose checks expiry against wall time.
        const past = 1_000_000;
        const failures = [
          yield* expectFailure(
            completeSignIn({ oid }, { tamper: (flow) => ({ ...flow, nonce: "replayed-nonce" }) }),
          ),
          yield* expectFailure(
            completeSignIn(
              { oid },
              { issuer: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` },
            ),
          ),
          yield* expectFailure(
            completeSignIn({ oid }, { audience: "22222222-2222-4333-8444-555555555555" }),
          ),
          yield* expectFailure(completeSignIn({ oid, tid: OTHER_TENANT })),
          yield* expectFailure(completeSignIn({ oid }, { key: "stranger" })),
          yield* expectFailure(completeSignIn({ oid }, { expiresAt: past })),
          yield* expectFailure(completeSignIn({ oid: "not-a-guid" })),
        ];
        expect(failures).toEqual(Array(failures.length).fill("invalid_id_token"));
        const registry = yield* UserRegistry.UserRegistry;
        expect(yield* registry.list()).toEqual([]);
      }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("reports a refused code exchange and Entra's own errors", () =>
    Effect.gen(function* () {
      const entra = yield* EntraSignIn.EntraSignIn;
      const started = yield* entra.start({ returnTo: null });
      const state = new URL(started.authorizationUrl).searchParams.get("state");
      const base = {
        state,
        flowCookie: started.flowCookie,
        client: { deviceType: "desktop" },
      } as const;

      expect(
        yield* expectFailure(entra.complete({ ...base, code: "never-issued", error: null })),
      ).toBe("token_exchange_failed");
      expect(
        yield* expectFailure(entra.complete({ ...base, code: null, error: "access_denied" })),
      ).toBe("provider_error");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("follows Entra's key rotation without a restart", () =>
    Effect.gen(function* () {
      yield* signInAs("1");
      publishedKeys = [publicJwk, rotatedJwk];

      // A key rotated in is fetched on first sight, once the cooldown allows.
      expect(yield* expectFailure(completeSignIn({ oid: objectId("1") }, { key: "rotated" }))).toBe(
        "invalid_id_token",
      );
      yield* TestClock.adjust(Duration.minutes(1));
      yield* completeSignIn({ oid: objectId("1") }, { key: "rotated" });

      // A key rotated out stays trusted only until the cache ages out.
      publishedKeys = [rotatedJwk];
      yield* signInAs("1");
      yield* TestClock.adjust(Duration.hours(24));
      expect(yield* expectFailure(signInAs("1"))).toBe("invalid_id_token");
      yield* completeSignIn({ oid: objectId("1") }, { key: "rotated" });
    }).pipe(
      Effect.ensuring(Effect.sync(() => (publishedKeys = [publicJwk]))),
      Effect.provide(makeLayer()),
    ),
  );

  it.effect("logs only a well-formed provider error code", () =>
    Effect.gen(function* () {
      const entra = yield* EntraSignIn.EntraSignIn;
      const started = yield* entra.start({ returnTo: null });
      const complete = (error: string) =>
        entra
          .complete({
            code: null,
            state: new URL(started.authorizationUrl).searchParams.get("state"),
            error,
            flowCookie: started.flowCookie,
            client: { deviceType: "desktop" },
          })
          .pipe(
            Effect.flip,
            Effect.map((failure) =>
              failure._tag === "EntraSignInError" ? failure.detail : failure.message,
            ),
          );

      expect(yield* complete("access_denied")).toBe("Entra returned access_denied.");
      expect(yield* complete("x\nlevel=error msg=forged")).toBe("Entra returned an error.");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("a first sign-in creates a pending user whose session can see only itself", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const signedIn = yield* completeSignIn(
        { oid: objectId("1").toUpperCase(), name: " Ada ", email: "ada@example.com" },
        { returnTo: "/threads/t-1" },
      );
      const request = cookieRequest(sessions.cookieName, signedIn.session.token);

      expect(signedIn.returnTo).toBe("/threads/t-1");
      expect(signedIn.session.scopes).toEqual([]);
      expect((yield* auth.authenticateHttpRequest(request)).scopes).toEqual([]);
      const state = yield* auth.getSessionState(request);
      expect(state).toMatchObject({
        authenticated: true,
        scopes: [],
        sessionMethod: "browser-session-cookie",
        auth: { entraSignIn: true },
        user: { status: "pending", role: null, displayName: "Ada", email: "ada@example.com" },
      });
      const registry = yield* UserRegistry.UserRegistry;
      // Object IDs are keyed lowercase whatever case the token used.
      expect(yield* registry.getByIdentity(identity("1"))).toMatchObject({
        _tag: "Some",
        value: { status: "pending" },
      });
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("an active user's session carries their role's scopes", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const registry = yield* UserRegistry.UserRegistry;
      const pending = yield* signInAs("1");
      const user = yield* registry.getByIdentity(identity("1"));
      if (user._tag === "None") throw new Error("user missing");
      yield* registry.approve({ userId: user.value.userId, role: "operator", actor: hostCli });

      // The session issued while pending gains access without signing in again.
      expect(
        (yield* auth.authenticateHttpRequest(
          cookieRequest(sessions.cookieName, pending.session.token),
        )).scopes,
      ).toEqual(AuthStandardClientScopes);
      const ticket = yield* auth.issueWebSocketTicket(
        yield* auth.authenticateHttpRequest(
          cookieRequest(sessions.cookieName, pending.session.token),
        ),
      );
      const socket = yield* auth.authenticateWebSocketUpgrade({
        url: `/ws?wsTicket=${ticket.ticket}`,
        originalUrl: `/ws?wsTicket=${ticket.ticket}`,
        headers: { host: "t3.example.com" },
        cookies: {},
      } as unknown as AuthRequest);
      expect(socket.scopes).toEqual(AuthStandardClientScopes);
      expect(socket.userId).toBe(user.value.userId);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("a host-provisioned administrator gets access on their next sign-in", () =>
    Effect.gen(function* () {
      const registry = yield* UserRegistry.UserRegistry;
      yield* registry.provisionAdministratorFromHost(identity("7"));

      const signedIn = yield* signInAs("7", { name: "Grace" });

      expect(signedIn.session.scopes).toEqual(AuthAdministrativeScopes);
      expect(yield* registry.list()).toHaveLength(1);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("demoting, disabling, or revoking a user cuts their sessions and open sockets", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const registry = yield* UserRegistry.UserRegistry;
      yield* registry.provisionAdministratorFromHost(identity("9"));
      const signedIn = yield* signInAs("1");
      const userId = (yield* registry.list()).find((user) => user.status === "pending")!.userId;
      yield* registry.approve({ userId, role: "administrator", actor: hostCli });
      const request = cookieRequest(sessions.cookieName, signedIn.session.token);

      // Each fiber stands in for one open socket authenticated at that moment.
      const asAdministrator = yield* auth.authenticateHttpRequest(request);
      expect(asAdministrator.scopes).toEqual(AuthAdministrativeScopes);
      const administratorSocket = yield* Effect.forkChild(
        auth.awaitSessionAccessChange(asAdministrator),
      );
      yield* registry.changeRole({ userId, role: "reader", actor: hostCli });
      yield* Fiber.join(administratorSocket);
      const asReader = yield* auth.authenticateHttpRequest(request);
      expect(asReader.scopes).toEqual(["orchestration:read"]);

      const readerSocket = yield* Effect.forkChild(auth.awaitSessionAccessChange(asReader));
      yield* registry.disable({ userId, actor: hostCli });
      yield* Fiber.join(readerSocket);
      const asDisabled = yield* auth.authenticateHttpRequest(request);
      expect(asDisabled.scopes).toEqual([]);
      expect((yield* auth.getSessionState(request)).user?.status).toBe("disabled");

      // A socket opened just before the change commits still closes.
      yield* registry.enable({ userId, actor: hostCli });
      yield* auth.awaitSessionAccessChange(asDisabled);

      const enabled = yield* auth.authenticateHttpRequest(request);
      const enabledSocket = yield* Effect.forkChild(auth.awaitSessionAccessChange(enabled));
      expect(yield* auth.revokeUserSessions(userId)).toBe(1);
      yield* Fiber.join(enabledSocket);
      const revoked = yield* Effect.result(auth.authenticateHttpRequest(request));
      expect(Result.isFailure(revoked)).toBe(true);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("a signed-in user's socket closes when their session expires", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const registry = yield* UserRegistry.UserRegistry;
      yield* registry.provisionAdministratorFromHost(identity("1"));
      const signedIn = yield* signInAs("1");
      const session = yield* auth.authenticateHttpRequest(
        cookieRequest(sessions.cookieName, signedIn.session.token),
      );

      const socket = yield* Effect.forkChild(auth.awaitSessionAccessChange(session));
      yield* TestClock.adjust(Duration.hours(12));
      yield* Fiber.join(socket);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect(
    "pairing cannot make a browser session while Entra is on; service tokens still work",
    () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const pairing = yield* auth.issuePairingCredential({ label: "Slack" });

        const browser = yield* Effect.result(
          auth.createBrowserSession(pairing.credential, { deviceType: "desktop" }),
        );
        expect(Result.isFailure(browser)).toBe(true);

        // The refused attempt did not consume the credential.
        const service = yield* auth.exchangeBootstrapCredentialForAccessToken(
          pairing.credential,
          ["orchestration:read", "orchestration:operate"],
          { deviceType: "bot" },
        );
        expect(
          (yield* auth.authenticateHttpRequest(bearerRequest(service.access_token))).scopes,
        ).toEqual(["orchestration:read", "orchestration:operate"]);
        const cliToken = yield* auth.issueSession({ label: "rotator" });
        expect((yield* auth.authenticateHttpRequest(bearerRequest(cliToken.token))).scopes).toEqual(
          AuthAdministrativeScopes,
        );

        // A pairing-derived browser session minted before Entra was turned on.
        const legacy = yield* sessions.issue({
          method: "browser-session-cookie",
          subject: "one-time-token",
        });
        const legacyRequest = cookieRequest(sessions.cookieName, legacy.token);
        expect(
          Result.isFailure(yield* Effect.result(auth.authenticateHttpRequest(legacyRequest))),
        ).toBe(true);
        expect((yield* auth.getSessionState(legacyRequest)).authenticated).toBe(false);
        const ticket = yield* auth.issueWebSocketTicket({ sessionId: legacy.sessionId });
        const socket = yield* Effect.result(
          auth.authenticateWebSocketUpgrade({
            url: `/ws?wsTicket=${ticket.ticket}`,
            originalUrl: `/ws?wsTicket=${ticket.ticket}`,
            headers: { host: "t3.example.com" },
            cookies: {},
          } as unknown as AuthRequest),
        );
        expect(Result.isFailure(socket)).toBe(true);
      }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("without Entra configuration, browser pairing behaves as before", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const entra = yield* EntraSignIn.EntraSignIn;
      const pairing = yield* auth.issuePairingCredential();

      const browser = yield* auth.createBrowserSession(pairing.credential, {
        deviceType: "desktop",
      });

      expect(browser.response.scopes).toEqual(AuthStandardClientScopes);
      expect(entra.enabled).toBe(false);
      expect((yield* auth.getDescriptor()).entraSignIn).toBe(false);
    }).pipe(Effect.provide(makeLayer({ entra: false }))),
  );
});

// ---------------------------------------------------------------------------
// HTTP transports, wired against the same services the assertions read.
// ---------------------------------------------------------------------------

class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const withWebHandler = <A>(
  use: (
    fetch: (path: string, init?: RequestInit & { readonly cookie?: string }) => Promise<Response>,
  ) => Promise<A>,
) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<
      | EnvironmentAuth.EnvironmentAuth
      | SessionStore.SessionStore
      | UserRegistry.UserRegistry
      | EntraSignIn.EntraSignIn
      | ServerConfig.ServerConfig
    >();
    const routes = Layer.mergeAll(
      HttpApiBuilder.layer(AuthTestApi).pipe(
        Layer.provide(authHttpApiLayer),
        Layer.provide(environmentAuthenticatedAuthLayer),
      ),
      entraSignInRouteLayer,
    ).pipe(
      Layer.provide(Layer.succeedContext(context)),
      Layer.provideMerge(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
    );
    const requestContext = yield* Effect.context<
      | Crypto.Crypto
      | ServerSecretStore.ServerSecretStore
      | EntraSignIn.EntraSignIn
      | SessionStore.SessionStore
    >();
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      (web) =>
        Effect.promise(() =>
          use((path, init) =>
            web.handler(
              new Request(`${PUBLIC_URL}${path}`, {
                ...init,
                headers: {
                  ...(init?.body ? { "content-type": "application/json" } : {}),
                  ...(init?.cookie ? { cookie: init.cookie } : {}),
                  ...(init?.headers as Record<string, string> | undefined),
                },
              }),
              requestContext,
            ),
          ),
        ),
      (web) => Effect.promise(() => web.dispose()),
    );
  });

const cookiePair = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.split(";", 1)[0];

it.layer(NodeServices.layer)("Entra sign-in HTTP routes", (it) => {
  it.effect("signs a browser in through start and callback, then signs it out", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const entra = yield* EntraSignIn.EntraSignIn;
      yield* withWebHandler(async (fetch) => {
        const start = await fetch("/api/auth/entra/start?returnTo=%2Fthreads%2Ft-1", {
          redirect: "manual",
        });
        expect(start.status).toBe(302);
        const authorize = new URL(start.headers.get("location") ?? "");
        const flowCookie = cookiePair(start, entra.flowCookieName);
        expect(start.headers.getSetCookie().join()).toMatch(/HttpOnly.*Secure|Secure.*HttpOnly/);

        const code = `code-${++codeCounter}`;
        issuedCodes.set(code, {
          idToken: await signIdToken({
            oid: objectId("1"),
            nonce: authorize.searchParams.get("nonce"),
            name: "Ada",
          }),
          challenge: authorize.searchParams.get("code_challenge") ?? "",
        });
        const callback = await fetch(
          `/api/auth/entra/callback?code=${code}&state=${authorize.searchParams.get("state")}`,
          { cookie: flowCookie ?? "" },
        );
        expect(callback.status).toBe(302);
        expect(callback.headers.get("location")).toBe("/threads/t-1");
        const sessionCookie = cookiePair(callback, sessions.cookieName);
        expect(sessionCookie).toBeDefined();
        expect(callback.headers.getSetCookie().join()).toMatch(
          new RegExp(`${entra.flowCookieName}=;.*Max-Age=0`),
        );

        const session = await fetch("/api/auth/session", { cookie: sessionCookie ?? "" });
        expect(await session.json()).toMatchObject({
          authenticated: true,
          scopes: [],
          user: { status: "pending", displayName: "Ada" },
        });

        const replay = await fetch(
          `/api/auth/entra/callback?code=${code}&state=${authorize.searchParams.get("state")}`,
          { cookie: flowCookie ?? "" },
        );
        expect(replay.headers.get("location")).toBe("/?signInError=token_exchange_failed");

        const signOut = await fetch("/api/auth/sign-out", {
          method: "POST",
          cookie: sessionCookie ?? "",
        });
        expect(await signOut.json()).toEqual({ signedOut: true });
        expect(signOut.headers.getSetCookie().join()).toMatch(
          new RegExp(`${sessions.cookieName}=;.*Max-Age=0`),
        );
        const after = await fetch("/api/auth/session", { cookie: sessionCookie ?? "" });
        expect(await after.json()).toMatchObject({ authenticated: false });
      });
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses a pairing credential at the browser-session route", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairing = yield* auth.issuePairingCredential();
      yield* withWebHandler(async (fetch) => {
        const response = await fetch("/api/auth/browser-session", {
          method: "POST",
          body: JSON.stringify({ credential: pairing.credential }),
        });
        expect(response.status).toBe(401);
        expect(response.headers.getSetCookie()).toEqual([]);
      });
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("only administrators who signed in as users can change user access", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const registry = yield* UserRegistry.UserRegistry;
      yield* registry.provisionAdministratorFromHost(identity("1"));
      const administrator = yield* signInAs("1");
      const operatorSession = yield* signInAs("2");
      yield* signInAs("3");
      const users = yield* registry.list();
      const userId = (suffix: string) =>
        users.find((user) => user.identity.objectId === objectId(suffix))!.userId;
      yield* registry.approve({ userId: userId("2"), role: "operator", actor: hostCli });
      const serviceToken = yield* auth.issueSession({ label: "rotator" });

      const asCookie = (token: string) => `${sessions.cookieName}=${token}`;
      yield* withWebHandler(async (fetch) => {
        const approve = (credential: { cookie?: string; bearer?: string }, role = "reader") =>
          fetch("/api/auth/users/approve", {
            method: "POST",
            body: JSON.stringify({ userId: userId("3"), role }),
            ...(credential.cookie ? { cookie: credential.cookie } : {}),
            ...(credential.bearer
              ? { headers: { authorization: `Bearer ${credential.bearer}` } }
              : {}),
          });

        const asOperator = await approve({ cookie: asCookie(operatorSession.session.token) });
        expect(asOperator.status).toBe(403);
        expect(await asOperator.json()).toMatchObject({ requiredScope: "access:write" });

        const asService = await approve({ bearer: serviceToken.token });
        expect(asService.status).toBe(403);
        expect(await asService.json()).toMatchObject({ reason: "user_session_required" });

        const asAdministrator = await approve({ cookie: asCookie(administrator.session.token) });
        expect(asAdministrator.status).toBe(200);
        expect(await asAdministrator.json()).toMatchObject({ status: "active", role: "reader" });

        const again = await approve({ cookie: asCookie(administrator.session.token) });
        expect(again.status).toBe(409);
        expect(await again.json()).toMatchObject({ reason: "invalid_transition" });

        const lastAdministrator = await fetch("/api/auth/users/disable", {
          method: "POST",
          body: JSON.stringify({ userId: userId("1") }),
          cookie: asCookie(administrator.session.token),
        });
        expect(lastAdministrator.status).toBe(409);
        expect(await lastAdministrator.json()).toMatchObject({ reason: "last_administrator" });

        const changes = await fetch(`/api/auth/users/access-changes?userId=${userId("3")}`, {
          cookie: asCookie(administrator.session.token),
        });
        expect(await changes.json()).toMatchObject([
          { actor: { type: "user", userId: userId("1") }, status: "active", role: "reader" },
        ]);

        const listAsOperator = await fetch("/api/auth/users", {
          cookie: asCookie(operatorSession.session.token),
        });
        expect(listAsOperator.status).toBe(403);

        const revokeAsService = await fetch("/api/auth/users/revoke-sessions", {
          method: "POST",
          body: JSON.stringify({ userId: userId("2") }),
          headers: { authorization: `Bearer ${serviceToken.token}` },
        });
        expect(revokeAsService.status).toBe(403);
        expect(await revokeAsService.json()).toMatchObject({ reason: "user_session_required" });
      });
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("with Entra on, signed-in users cannot mint pairing credentials over HTTP", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const registry = yield* UserRegistry.UserRegistry;
      yield* registry.provisionAdministratorFromHost(identity("1"));
      const administrator = yield* signInAs("1");
      // Slack's rotator: a host-issued service session that renews the daemon's credential.
      const rotator = yield* auth.issueSession({ label: "t3-slack-rotator" });
      yield* withWebHandler(async (fetch) => {
        const mint = (credential: { cookie: string } | { headers: Record<string, string> }) =>
          fetch("/api/auth/pairing-token", {
            method: "POST",
            body: JSON.stringify({ label: "keep me", scopes: ["orchestration:read"] }),
            ...credential,
          });

        const asAdministrator = await mint({
          cookie: `${sessions.cookieName}=${administrator.session.token}`,
        });
        expect(asAdministrator.status).toBe(403);
        expect(await asAdministrator.json()).toMatchObject({ reason: "host_cli_required" });

        const asRotator = await mint({ headers: { authorization: `Bearer ${rotator.token}` } });
        expect(asRotator.status).toBe(200);
      });
      expect((yield* auth.listPairingLinks()).map((link) => link.label)).toEqual(["keep me"]);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("without Entra, administrators still mint pairing credentials over HTTP", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const serviceToken = yield* auth.issueSession({ label: "admin" });
      yield* withWebHandler(async (fetch) => {
        const response = await fetch("/api/auth/pairing-token", {
          method: "POST",
          body: JSON.stringify({ label: "phone" }),
          headers: { authorization: `Bearer ${serviceToken.token}` },
        });
        expect(response.status).toBe(200);
      });
      expect(yield* auth.listPairingLinks()).toHaveLength(1);
    }).pipe(Effect.provide(makeLayer({ entra: false }))),
  );

  it.effect("sign-out revokes a pairing-derived browser session Entra no longer admits", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const legacy = yield* sessions.issue({
        method: "browser-session-cookie",
        subject: "one-time-token",
      });
      yield* withWebHandler(async (fetch) => {
        const signOut = await fetch("/api/auth/sign-out", {
          method: "POST",
          cookie: `${sessions.cookieName}=${legacy.token}`,
        });
        expect(await signOut.json()).toEqual({ signedOut: true });
        const cleared = signOut.headers.getSetCookie().join();
        for (const name of [
          sessions.cookieName,
          sessions.legacyCookieName ?? sessions.cookieName,
        ]) {
          expect(cleared).toMatch(new RegExp(`${name}=;.*Max-Age=0`));
        }
      });
      const verified = yield* Effect.result(sessions.verify(legacy.token));
      expect(Result.isFailure(verified)).toBe(true);
    }).pipe(Effect.provide(makeLayer())),
  );
});
