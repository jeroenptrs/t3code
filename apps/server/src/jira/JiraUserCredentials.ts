import {
  JiraError,
  type AuthUserId,
  type JiraPersonalCredential,
  type JiraPersonalTokenSetInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as JiraApi from "./JiraApi.ts";
import { normalizeJiraSite, type JiraServerIdentity } from "./JiraConfig.ts";
import * as JiraIdentities from "./JiraIdentities.ts";
import { toJiraUser } from "./issueMapping.ts";

/**
 * A portal user's own Jira token. Only the user's own UI reads use it; background work and agents
 * always read as the configured service identities.
 */

const CredentialRow = Schema.Struct({
  site: Schema.String,
  cloudId: Schema.NullOr(Schema.String),
  accountId: Schema.NullOr(Schema.String),
  accountDisplayName: Schema.NullOr(Schema.String),
  accountAvatarUrl: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  lastVerifiedAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
});
type CredentialRow = typeof CredentialRow.Type;
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(CredentialRow));

const StoredToken = Schema.fromJsonString(
  Schema.Struct({ email: Schema.String, token: Schema.String }),
);
const decodeStoredToken = Schema.decodeUnknownEffect(StoredToken);
const encodeStoredToken = Schema.encodeEffect(StoredToken);

export class JiraUserCredentials extends Context.Service<
  JiraUserCredentials,
  {
    /**
     * Verifies the token with Jira, then stores or replaces the caller's credential. A token Jira
     * rejects stores nothing.
     */
    readonly set: (
      userId: AuthUserId | undefined,
      input: JiraPersonalTokenSetInput,
    ) => Effect.Effect<JiraPersonalCredential, JiraError>;
    /** Asks Jira again with the stored token and records whether it was accepted. */
    readonly test: (
      userId: AuthUserId | undefined,
    ) => Effect.Effect<JiraPersonalCredential, JiraError>;
    /** Removes the caller's token; succeeds when there is none. */
    readonly clear: (userId: AuthUserId | undefined) => Effect.Effect<void, JiraError>;
    /** The stored public shape, without asking Jira; null when the user has no token. */
    readonly get: (userId: AuthUserId) => Effect.Effect<JiraPersonalCredential | null, JiraError>;
    /** The identity to read `site` as for this user; undefined when they have no token for it. */
    readonly identityFor: (
      userId: AuthUserId,
      site: string,
    ) => Effect.Effect<JiraServerIdentity | undefined, JiraError>;
    /** Records why Jira refused a personal identity, unless the credential was replaced since. */
    readonly recordRejected: (
      identity: JiraServerIdentity,
      message: string,
    ) => Effect.Effect<void, JiraError>;
  }
>()("t3/jira/JiraUserCredentials") {}

/** Secret store entry for one user's token; the name stays stable across releases. */
const secretName = (userId: AuthUserId) =>
  `jira-user-token-${Buffer.from(userId, "utf8").toString("base64url")}`;

const signInRequired = new JiraError({
  reason: "forbidden",
  message: "Sign in to T3 Code with your organisation account to store a personal Jira token.",
});

const noCredential = new JiraError({
  reason: "not-found",
  message: "You have no personal Jira token stored.",
});

const storageFailed = (what: string) => () =>
  new JiraError({ reason: "unavailable", message: `Could not ${what} your personal Jira token.` });

const requireUser = (userId: AuthUserId | undefined) =>
  userId === undefined ? Effect.fail(signInRequired) : Effect.succeed(userId);

const toPublic = (row: CredentialRow): JiraPersonalCredential => ({
  site: row.site,
  account:
    row.accountId === null
      ? null
      : {
          accountId: row.accountId,
          displayName: row.accountDisplayName ?? "",
          avatarUrl: row.accountAvatarUrl,
        },
  createdAt: row.createdAt,
  lastVerifiedAt: row.lastVerifiedAt,
  error: row.lastError,
});

const toIdentity = (
  userId: AuthUserId,
  row: CredentialRow,
  stored: { readonly email: string; readonly token: string },
): JiraServerIdentity => ({
  // Unique per user and per credential version, so read caches keyed by it are never shared.
  name: `user:${userId}:${row.createdAt}`,
  site: row.site,
  authMethod: "basic",
  email: stored.email,
  token: Redacted.make(stored.token),
  ...(row.cloudId === null ? {} : { cloudId: row.cloudId }),
  personal: { userId, createdAt: row.createdAt },
});

const isRefusal = (error: JiraError) =>
  error.reason === "unauthorized" || error.reason === "forbidden";

const make = Effect.gen(function* () {
  const identities = yield* JiraIdentities.JiraIdentities;
  const api = yield* JiraApi.JiraApi;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sql = yield* SqlClient.SqlClient;

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const readRow = (userId: AuthUserId) =>
    sql`
      SELECT site, cloud_id AS "cloudId", account_id AS "accountId",
        account_display_name AS "accountDisplayName", account_avatar_url AS "accountAvatarUrl",
        created_at AS "createdAt", last_verified_at AS "lastVerifiedAt", last_error AS "lastError"
      FROM fork_jira_user_credentials
      WHERE user_id = ${userId}
    `.pipe(
      Effect.flatMap(decodeRows),
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(storageFailed("read")),
    );

  const readSecret = (userId: AuthUserId) =>
    secrets.get(secretName(userId)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(null),
          onSome: (bytes) => decodeStoredToken(new TextDecoder().decode(bytes)),
        }),
      ),
      Effect.mapError(storageFailed("read")),
    );

  const writeRow = (userId: AuthUserId, row: CredentialRow) =>
    sql`
      INSERT INTO fork_jira_user_credentials (
        user_id, site, cloud_id, account_id, account_display_name, account_avatar_url,
        created_at, last_verified_at, last_error
      ) VALUES (
        ${userId}, ${row.site}, ${row.cloudId}, ${row.accountId}, ${row.accountDisplayName},
        ${row.accountAvatarUrl}, ${row.createdAt}, ${row.lastVerifiedAt}, ${row.lastError}
      )
      ON CONFLICT (user_id) DO UPDATE SET
        site = excluded.site,
        cloud_id = excluded.cloud_id,
        account_id = excluded.account_id,
        account_display_name = excluded.account_display_name,
        account_avatar_url = excluded.account_avatar_url,
        created_at = excluded.created_at,
        last_verified_at = excluded.last_verified_at,
        last_error = excluded.last_error
    `;

  /** The configured site the token is for: the requested one, else the reader's. */
  const resolveSite = (requested: string | undefined) =>
    Effect.gen(function* () {
      const reader = yield* identities.reader;
      if (requested === undefined) return reader.site;
      const site = normalizeJiraSite(requested);
      const configured = [...new Set(identities.list.map((identity) => identity.site))];
      if (site === null || !configured.includes(site)) {
        return yield* new JiraError({
          reason: "invalid",
          message: `Personal Jira tokens can only be stored for ${configured.join(", ")}.`,
        });
      }
      return site;
    });

  const set: JiraUserCredentials["Service"]["set"] = Effect.fn("JiraUserCredentials.set")(
    function* (maybeUserId, input) {
      const userId = yield* requireUser(maybeUserId);
      const site = yield* resolveSite(input.site);
      const cloudId = yield* api.tenantInfo(site);
      const createdAt = yield* now;
      const stored = { email: input.email, token: input.token };
      const candidate = (cloudId: string | null): CredentialRow => ({
        site,
        cloudId,
        accountId: null,
        accountDisplayName: null,
        accountAvatarUrl: null,
        createdAt,
        lastVerifiedAt: null,
        lastError: null,
      });
      // User scoped tokens only work through the gateway, classic ones also on the site itself.
      const verify = (row: CredentialRow) =>
        api.myself(toIdentity(userId, row, stored)).pipe(Effect.map((user) => ({ row, user })));
      const verified = yield* verify(candidate(cloudId)).pipe(
        Effect.catchTags({
          JiraError: (error) => (isRefusal(error) ? verify(candidate(null)) : Effect.fail(error)),
        }),
        Effect.catchTags({
          JiraError: (error) =>
            Effect.fail(
              error.reason === "unauthorized"
                ? new JiraError({
                    reason: "unauthorized",
                    message: `Jira at ${site} rejected this email and token.`,
                  })
                : error,
            ),
        }),
      );
      const account = toJiraUser(verified.user);
      const row: CredentialRow = {
        ...verified.row,
        accountId: account?.accountId ?? null,
        accountDisplayName: account?.displayName ?? null,
        accountAvatarUrl: account?.avatarUrl ?? null,
        lastVerifiedAt: createdAt,
      };

      // Write the secret, then the row; a failed row write puts the previous secret back.
      const name = secretName(userId);
      const previous = yield* secrets.get(name).pipe(Effect.mapError(storageFailed("store")));
      const bytes = new TextEncoder().encode(
        yield* encodeStoredToken(stored).pipe(Effect.mapError(storageFailed("store"))),
      );
      yield* secrets.set(name, bytes).pipe(Effect.mapError(storageFailed("store")));
      yield* writeRow(userId, row).pipe(
        Effect.tapError(() =>
          (Option.isSome(previous) ? secrets.set(name, previous.value) : secrets.remove(name)).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("failed to roll back a personal Jira token", { cause }),
            ),
          ),
        ),
        Effect.mapError(storageFailed("store")),
      );
      return toPublic(row);
    },
  );

  const test: JiraUserCredentials["Service"]["test"] = Effect.fn("JiraUserCredentials.test")(
    function* (maybeUserId) {
      const userId = yield* requireUser(maybeUserId);
      const [row, stored] = yield* Effect.all([readRow(userId), readSecret(userId)]);
      if (row === null || stored === null) return yield* noCredential;
      const result = yield* api.myself(toIdentity(userId, row, stored)).pipe(
        Effect.map((user) => ({ user, error: null })),
        Effect.catchTags({
          JiraError: (error) =>
            isRefusal(error)
              ? Effect.succeed({ user: null, error: error.message })
              : Effect.fail(error),
        }),
      );
      const account = result.user === null ? null : toJiraUser(result.user);
      const next: CredentialRow =
        result.error === null
          ? {
              ...row,
              accountId: account?.accountId ?? null,
              accountDisplayName: account?.displayName ?? null,
              accountAvatarUrl: account?.avatarUrl ?? null,
              lastVerifiedAt: yield* now,
              lastError: null,
            }
          : { ...row, lastError: result.error };
      yield* sql`
        UPDATE fork_jira_user_credentials
        SET account_id = ${next.accountId},
          account_display_name = ${next.accountDisplayName},
          account_avatar_url = ${next.accountAvatarUrl},
          last_verified_at = ${next.lastVerifiedAt},
          last_error = ${next.lastError}
        WHERE user_id = ${userId} AND created_at = ${row.createdAt}
      `.pipe(Effect.mapError(storageFailed("update")));
      return toPublic(next);
    },
  );

  const clear: JiraUserCredentials["Service"]["clear"] = Effect.fn("JiraUserCredentials.clear")(
    function* (maybeUserId) {
      const userId = yield* requireUser(maybeUserId);
      // The secret goes first: a row without its secret reads as no credential.
      yield* secrets.remove(secretName(userId)).pipe(Effect.mapError(storageFailed("remove")));
      yield* sql`DELETE FROM fork_jira_user_credentials WHERE user_id = ${userId}`.pipe(
        Effect.mapError(storageFailed("remove")),
      );
    },
  );

  const get: JiraUserCredentials["Service"]["get"] = (userId) =>
    readRow(userId).pipe(Effect.map((row) => (row === null ? null : toPublic(row))));

  const identityFor: JiraUserCredentials["Service"]["identityFor"] = (userId, site) =>
    Effect.gen(function* () {
      const row = yield* readRow(userId);
      if (row === null || row.site !== normalizeJiraSite(site)) return undefined;
      const stored = yield* readSecret(userId);
      return stored === null ? undefined : toIdentity(userId, row, stored);
    });

  const recordRejected: JiraUserCredentials["Service"]["recordRejected"] = (identity, message) =>
    identity.personal === undefined
      ? Effect.void
      : sql`
          UPDATE fork_jira_user_credentials SET last_error = ${message}
          WHERE user_id = ${identity.personal.userId}
            AND created_at = ${identity.personal.createdAt}
        `.pipe(Effect.asVoid, Effect.mapError(storageFailed("update")));

  return JiraUserCredentials.of({ set, test, clear, get, identityFor, recordRejected });
});

export const layer = Layer.effect(JiraUserCredentials, make);
