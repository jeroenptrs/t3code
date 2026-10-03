import * as NodeCrypto from "node:crypto";

import {
  AuthUserIdentity,
  EntraSignInFailureReason,
  type AuthClientMetadata,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { createLocalJWKSet, errors as JoseErrors, jwtVerify, type JSONWebKeySet } from "jose";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import * as UserRegistry from "./UserRegistry.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "./utils.ts";

const ENTRA_AUTHORITY = "https://login.microsoftonline.com";
const FLOW_SIGNING_SECRET_NAME = "entra-sign-in-flow-key";
const FLOW_TTL = Duration.minutes(10);
/** Sign-in sessions end on their own; the user signs in again through Entra. */
const ENTRA_SESSION_TTL = Duration.hours(12);
/** Entra rotates keys; an unknown `kid` refetches, at most this often. */
const KEYS_REFRESH_COOLDOWN = Duration.minutes(1);
const ID_TOKEN_CLOCK_TOLERANCE_SECONDS = 60;
const MAX_RETURN_PATH_LENGTH = 2048;

export class EntraSignInDisabledError extends Schema.TaggedError<EntraSignInDisabledError>()(
  "EntraSignInDisabledError",
  {},
) {
  override get message(): string {
    return "Entra sign-in is not configured on this server.";
  }
}

export class EntraSignInError extends Schema.TaggedError<EntraSignInError>()("EntraSignInError", {
  reason: EntraSignInFailureReason,
  /** Safe for logs: never contains tokens, codes, or secrets. */
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Entra sign-in failed (${this.reason}).`;
  }
}

/** A jose verification failure; `code` is jose's stable error code. */
class IdTokenVerificationError extends Schema.TaggedError<IdTokenVerificationError>()(
  "IdTokenVerificationError",
  { code: Schema.String, cause: Schema.Defect() },
) {}

const fail = (reason: EntraSignInFailureReason, detail: string, cause?: unknown) =>
  new EntraSignInError({ reason, detail, ...(cause === undefined ? {} : { cause }) });

export interface EntraSignInStart {
  readonly authorizationUrl: string;
  /** Binds the callback to this browser. HttpOnly, scoped to the callback path. */
  readonly flowCookie: string;
  readonly flowCookieMaxAge: Duration.Duration;
}

export interface EntraSignInCompleted {
  readonly session: SessionStore.IssuedSession;
  readonly returnTo: string;
}

export class EntraSignIn extends Context.Service<
  EntraSignIn,
  {
    readonly enabled: boolean;
    readonly flowCookieName: string;
    readonly flowCookiePath: string;
    /** True when the public URL is HTTPS, so cookies set by these routes are `Secure`. */
    readonly secureCookies: boolean;
    /** Starts an authorization code flow with PKCE against the configured tenant. */
    readonly start: (input: {
      readonly returnTo: string | null;
    }) => Effect.Effect<EntraSignInStart, EntraSignInDisabledError>;
    /**
     * Validates the callback against the flow cookie, redeems the code,
     * verifies the ID token, records the sign-in, and issues a browser
     * session bound to the user.
     */
    readonly complete: (input: {
      readonly code: string | null;
      readonly state: string | null;
      readonly error: string | null;
      readonly flowCookie: string | undefined;
      readonly client: AuthClientMetadata;
    }) => Effect.Effect<EntraSignInCompleted, EntraSignInDisabledError | EntraSignInError>;
  }
>()("t3/auth/EntraSignIn") {}

/**
 * Returns a same-origin path to land on after sign-in, or `/`. Only relative
 * paths are honored, so a crafted link cannot send a freshly signed-in browser
 * to another site.
 */
export function sanitizeReturnPath(value: string | null | undefined): string {
  if (
    !value ||
    value.length > MAX_RETURN_PATH_LENGTH ||
    !value.startsWith("/") ||
    // Browsers read `\` as `/`, so `/\evil.example` is protocol-relative too.
    Array.from(value).some(
      (char) => char === "\\" || char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f,
    ) ||
    value.startsWith("//")
  ) {
    return "/";
  }
  const base = "http://return-path.invalid";
  if (!URL.canParse(value, base)) {
    return "/";
  }
  const url = new URL(value, base);
  return url.origin === base ? `${url.pathname}${url.search}${url.hash}` : "/";
}

const FlowClaims = Schema.Struct({
  v: Schema.Literal(1),
  state: Schema.String,
  nonce: Schema.String,
  verifier: Schema.String,
  returnTo: Schema.String,
  exp: Schema.Number,
});
type FlowClaims = typeof FlowClaims.Type;
const encodeFlowClaims = Schema.encodeSync(Schema.fromJsonString(FlowClaims));
const decodeFlowClaims = Schema.decodeUnknownOption(Schema.fromJsonString(FlowClaims));

const TokenResponse = Schema.Struct({ id_token: Schema.String });
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);
const TokenErrorResponse = Schema.Struct({
  error: Schema.optional(Schema.String),
  error_codes: Schema.optional(Schema.Array(Schema.Number)),
});
const decodeTokenErrorResponse = Schema.decodeUnknownOption(TokenErrorResponse);
const KeySetResponse = Schema.Struct({
  keys: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeKeySetResponse = Schema.decodeUnknownEffect(KeySetResponse);
const decodeIdentity = Schema.decodeUnknownOption(AuthUserIdentity);

const randomToken = () => NodeCrypto.randomBytes(32).toString("base64url");
const pkceChallenge = (verifier: string) =>
  NodeCrypto.createHash("sha256").update(verifier).digest("base64url");

const label = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const disabled = EntraSignIn.of({
  enabled: false,
  flowCookieName: "t3_entra_flow",
  flowCookiePath: "/api/auth/entra",
  secureCookies: false,
  start: () => Effect.fail(new EntraSignInDisabledError()),
  complete: () => Effect.fail(new EntraSignInDisabledError()),
});

const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const config = serverConfig.entraSignIn;
  const sessions = yield* SessionStore.SessionStore;
  const users = yield* UserRegistry.UserRegistry;
  const http = yield* HttpClient.HttpClient;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  if (config === undefined) {
    return disabled;
  }

  const flowSigningKey = yield* secretStore.getOrCreateRandom(FLOW_SIGNING_SECRET_NAME, 32);
  const tenantBase = `${ENTRA_AUTHORITY}/${config.tenantId}`;
  const issuer = `${tenantBase}/v2.0`;
  const redirectUri = new URL("/api/auth/entra/callback", config.publicUrl).toString();
  const flowCookieName = `${sessions.cookieName}_entra_flow`;
  const keysRef = yield* Ref.make<{ keys: JSONWebKeySet; fetchedAt: number } | null>(null);

  const signFlow = (claims: FlowClaims) => {
    const payload = base64UrlEncode(encodeFlowClaims(claims));
    return `${payload}.${signPayload(payload, flowSigningKey)}`;
  };

  const readFlow = (cookie: string | undefined, now: number): Option.Option<FlowClaims> => {
    const [payload, signature] = cookie?.split(".") ?? [];
    if (!payload || !signature) {
      return Option.none();
    }
    if (!timingSafeEqualBase64Url(signature, signPayload(payload, flowSigningKey))) {
      return Option.none();
    }
    return decodeFlowClaims(base64UrlDecodeUtf8(payload)).pipe(
      Option.filter((claims) => claims.exp > now),
    );
  };

  const start: EntraSignIn["Service"]["start"] = (input) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const verifier = randomToken();
      const claims: FlowClaims = {
        v: 1,
        state: randomToken(),
        nonce: randomToken(),
        verifier,
        returnTo: sanitizeReturnPath(input.returnTo),
        exp: now + Duration.toMillis(FLOW_TTL),
      };
      const url = new URL(`${tenantBase}/oauth2/v2.0/authorize`);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        response_mode: "query",
        scope: "openid profile email",
        state: claims.state,
        nonce: claims.nonce,
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: "S256",
      }).toString();
      return {
        authorizationUrl: url.toString(),
        flowCookie: signFlow(claims),
        flowCookieMaxAge: FLOW_TTL,
      } satisfies EntraSignInStart;
    }).pipe(Effect.withSpan("EntraSignIn.start"));

  const redeemCode = (code: string, verifier: string) =>
    Effect.gen(function* () {
      const response = yield* http
        .execute(
          HttpClientRequest.post(`${tenantBase}/oauth2/v2.0/token`).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyUrlParams({
              client_id: config.clientId,
              client_secret: Redacted.value(config.clientSecret),
              grant_type: "authorization_code",
              code,
              redirect_uri: redirectUri,
              code_verifier: verifier,
              scope: "openid profile email",
            }),
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            fail("token_exchange_failed", "Could not reach the Entra token endpoint.", cause),
          ),
        );
      const body = yield* response.json.pipe(
        Effect.mapError((cause) =>
          fail("token_exchange_failed", "Entra returned an unreadable token response.", cause),
        ),
      );
      if (response.status !== 200) {
        // Entra's error code and AADSTS numbers identify the problem without
        // echoing anything secret.
        const error = decodeTokenErrorResponse(body);
        return yield* fail(
          "token_exchange_failed",
          `Entra rejected the authorization code (HTTP ${response.status}${Option.match(error, {
            onNone: () => "",
            onSome: (value) =>
              `, ${value.error ?? "unknown_error"}${value.error_codes ? ` ${value.error_codes.join(",")}` : ""}`,
          })}).`,
        );
      }
      return yield* decodeTokenResponse(body).pipe(
        Effect.map((tokens) => tokens.id_token),
        Effect.mapError((cause) =>
          fail("token_exchange_failed", "Entra's token response has no ID token.", cause),
        ),
      );
    });

  const keysUnavailable = (cause: unknown) =>
    fail("invalid_id_token", "Could not load the tenant's signing keys.", cause);

  const fetchKeys = Effect.gen(function* () {
    const response = yield* http
      .get(`${tenantBase}/discovery/v2.0/keys`)
      .pipe(Effect.mapError(keysUnavailable));
    if (response.status !== 200) {
      return yield* keysUnavailable(`HTTP ${response.status}`);
    }
    const keySet = yield* response.json.pipe(
      Effect.flatMap(decodeKeySetResponse),
      Effect.mapError(keysUnavailable),
    );
    const entry = {
      keys: keySet as unknown as JSONWebKeySet,
      fetchedAt: yield* Clock.currentTimeMillis,
    };
    yield* Ref.set(keysRef, entry);
    return entry;
  });

  const verifyWithKeys = (idToken: string, keys: JSONWebKeySet) =>
    Effect.tryPromise({
      try: () =>
        jwtVerify(idToken, createLocalJWKSet(keys), {
          issuer,
          audience: config.clientId,
          algorithms: ["RS256"],
          clockTolerance: ID_TOKEN_CLOCK_TOLERANCE_SECONDS,
          requiredClaims: ["exp", "iat", "nonce", "tid", "oid"],
        }),
      catch: (cause) =>
        new IdTokenVerificationError({
          code: cause instanceof JoseErrors.JOSEError ? cause.code : "unknown",
          cause,
        }),
    });

  const verifyIdToken = (idToken: string, nonce: string) =>
    Effect.gen(function* () {
      const keys = (yield* Ref.get(keysRef)) ?? (yield* fetchKeys);
      const now = yield* Clock.currentTimeMillis;
      const verified = yield* verifyWithKeys(idToken, keys.keys).pipe(
        Effect.catchIf(
          (error) =>
            error.code === JoseErrors.JWKSNoMatchingKey.code &&
            now - keys.fetchedAt >= Duration.toMillis(KEYS_REFRESH_COOLDOWN),
          () => fetchKeys.pipe(Effect.flatMap((fresh) => verifyWithKeys(idToken, fresh.keys))),
        ),
        Effect.catchTag("IdTokenVerificationError", (error) =>
          Effect.fail(fail("invalid_id_token", `ID token rejected (${error.code}).`, error.cause)),
        ),
      );
      const claims = verified.payload;
      if (claims.nonce !== nonce) {
        return yield* fail("invalid_id_token", "ID token nonce does not match this sign-in.");
      }
      const identity = decodeIdentity({ tenantId: claims.tid, objectId: claims.oid });
      if (Option.isNone(identity) || identity.value.tenantId !== config.tenantId) {
        return yield* fail("invalid_id_token", "ID token is not for the configured tenant.");
      }
      return {
        identity: identity.value,
        email: label(claims.email) ?? label(claims.preferred_username),
        displayName: label(claims.name),
      };
    });

  const complete: EntraSignIn["Service"]["complete"] = (input) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const flow = readFlow(input.flowCookie, now);
      if (Option.isNone(flow)) {
        return yield* fail("invalid_state", "Sign-in flow cookie is missing, expired, or invalid.");
      }
      if (input.state === null || input.state !== flow.value.state) {
        return yield* fail("invalid_state", "Callback state does not match this browser's flow.");
      }
      if (input.error !== null) {
        return yield* fail("provider_error", `Entra returned ${label(input.error) ?? "an error"}.`);
      }
      if (input.code === null) {
        return yield* fail("provider_error", "Entra returned no authorization code.");
      }
      const idToken = yield* redeemCode(input.code, flow.value.verifier);
      const signedIn = yield* verifyIdToken(idToken, flow.value.nonce);
      const user = yield* users
        .recordSignIn(signedIn)
        .pipe(
          Effect.mapError((cause) =>
            fail("internal_error", "Could not record the sign-in.", cause),
          ),
        );
      const session = yield* sessions
        .issue({
          method: "browser-session-cookie",
          subject: `entra:${user.userId}`,
          ttl: ENTRA_SESSION_TTL,
          user: {
            userId: user.userId,
            status: user.status,
            role: user.role,
            email: user.email,
            displayName: user.displayName,
          },
          client: {
            ...input.client,
            label: user.displayName ?? user.email ?? "Entra user",
          },
        })
        .pipe(
          Effect.mapError((cause) =>
            fail("internal_error", "Could not issue the browser session.", cause),
          ),
        );
      return { session, returnTo: flow.value.returnTo } satisfies EntraSignInCompleted;
    }).pipe(Effect.withSpan("EntraSignIn.complete"));

  return EntraSignIn.of({
    enabled: true,
    flowCookieName,
    flowCookiePath: "/api/auth/entra",
    secureCookies: config.publicUrl.protocol === "https:",
    start,
    complete,
  });
});

export const layer = Layer.effect(EntraSignIn, make);
