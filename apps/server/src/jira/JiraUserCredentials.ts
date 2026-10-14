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
import * as Semaphore from "effect/Semaphore";
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
type StoredToken = typeof StoredToken.Type;
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
    /**
     * The identity to read `site` as for this user; undefined when they have no token for it.
     * Fails when they have one whose secret is gone, rather than reading as the service identity.
     */
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

/** Recorded on a credential row whose secret is gone, and reported when it is read. */
const MISSING_TOKEN = "The stored token is missing; save it again in Settings → Account.";

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
  stored: StoredToken,
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

  const writeLastError = (userId: AuthUserId, createdAt: string, message: string) =>
    sql`
      UPDATE fork_jira_user_credentials SET last_error = ${message}
      WHERE user_id = ${userId} AND created_at = ${createdAt}
    `.pipe(Effect.asVoid, Effect.mapError(storageFailed("update")));

  /**
   * Set, test, clear and rejection records for one user run one at a time, so a token is never
   * stored next to another request's row and the resolved cache is never refilled mid-change.
   */
  const locks = new Map<AuthUserId, Semaphore.Semaphore>();
  const exclusive =
    (userId: AuthUserId) =>
    <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> => {
      let lock = locks.get(userId);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(userId, lock);
      }
      return lock.withPermit(effect);
    };

  /**
   * Each user's row and secret as last read, so steady-state UI reads touch neither the database
   * nor the secret store. Every change invalidates its user's entry; null caches "no credential".
   */
  type Resolved = { readonly row: CredentialRow; readonly stored: StoredToken | null } | null;
  const resolved = new Map<AuthUserId, Resolved>();
  const invalidate = (userId: AuthUserId) => Effect.sync(() => void resolved.delete(userId));

  const resolve = (userId: AuthUserId): Effect.Effect<Resolved, JiraError> => {
    const cached = resolved.get(userId);
    if (cached !== undefined) return Effect.succeed(cached);
    return exclusive(userId)(
      Effect.gen(function* () {
        const again = resolved.get(userId);
        if (again !== undefined) return again;
        const [row, stored] = yield* Effect.all([readRow(userId), readSecret(userId)]);
        let entry: Resolved = row === null ? null : { row, stored };
        if (row !== null && stored === null && row.lastError !== MISSING_TOKEN) {
          yield* writeLastError(userId, row.createdAt, MISSING_TOKEN);
          entry = { row: { ...row, lastError: MISSING_TOKEN }, stored };
        }
        resolved.set(userId, entry);
        return entry;
      }),
    );
  };

  const set: JiraUserCredentials["Service"]["set"] = Effect.fn("JiraUserCredentials.set")(
    function* (maybeUserId, input) {
      const userId = yield* requireUser(maybeUserId);
      const site = yield* resolveSite(input.site);
      return yield* exclusive(userId)(
        Effect.gen(function* () {
          // Without a cloud id only the site route is tried, which classic tokens still pass.
          const cloudId = yield* api.tenantInfo(site).pipe(
            Effect.catchTags({
              JiraError: (error) =>
                Effect.logWarning("could not read the Jira cloud id; trying the site only", {
                  site,
                  reason: error.reason,
                }).pipe(Effect.as(null)),
            }),
          );
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
          // User scoped tokens only work through the gateway, classic ones also on the site
          // itself. Only a 401 there means "not a gateway token"; a 403 is Jira's real answer.
          const verify = (row: CredentialRow) =>
            api.myself(toIdentity(userId, row, stored)).pipe(Effect.map((user) => ({ row, user })));
          const onSite = verify(candidate(null));
          const verified = yield* (
            cloudId === null
              ? onSite
              : verify(candidate(cloudId)).pipe(
                  Effect.catchTags({
                    JiraError: (error) =>
                      error.reason === "unauthorized" ? onSite : Effect.fail(error),
                  }),
                )
          ).pipe(
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
              (Option.isSome(previous)
                ? secrets.set(name, previous.value)
                : secrets.remove(name)
              ).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("failed to roll back a personal Jira token", { cause }),
                ),
              ),
            ),
            Effect.mapError(storageFailed("store")),
          );
          return toPublic(row);
        }).pipe(Effect.ensuring(invalidate(userId))),
      );
    },
  );

  const test: JiraUserCredentials["Service"]["test"] = Effect.fn("JiraUserCredentials.test")(
    function* (maybeUserId) {
      const userId = yield* requireUser(maybeUserId);
      return yield* exclusive(userId)(
        Effect.gen(function* () {
          const [row, stored] = yield* Effect.all([readRow(userId), readSecret(userId)]);
          if (row === null) return yield* noCredential;
          if (stored === null) {
            yield* writeLastError(userId, row.createdAt, MISSING_TOKEN);
            return toPublic({ ...row, lastError: MISSING_TOKEN });
          }
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
        }).pipe(Effect.ensuring(invalidate(userId))),
      );
    },
  );

  const clear: JiraUserCredentials["Service"]["clear"] = Effect.fn("JiraUserCredentials.clear")(
    function* (maybeUserId) {
      const userId = yield* requireUser(maybeUserId);
      // The secret goes first: a row left without its secret reads as a broken credential, which
      // the user can see and clear again, never as a working one.
      yield* exclusive(userId)(
        Effect.gen(function* () {
          yield* secrets.remove(secretName(userId));
          yield* sql`DELETE FROM fork_jira_user_credentials WHERE user_id = ${userId}`;
        }).pipe(Effect.mapError(storageFailed("remove")), Effect.ensuring(invalidate(userId))),
      );
    },
  );

  const get: JiraUserCredentials["Service"]["get"] = (userId) =>
    resolve(userId).pipe(Effect.map((entry) => (entry === null ? null : toPublic(entry.row))));

  const identityFor: JiraUserCredentials["Service"]["identityFor"] = (userId, site) =>
    Effect.gen(function* () {
      const entry = yield* resolve(userId);
      if (entry === null || entry.row.site !== normalizeJiraSite(site)) return undefined;
      if (entry.stored === null) {
        return yield* new JiraError({ reason: "unauthorized", message: MISSING_TOKEN });
      }
      return toIdentity(userId, entry.row, entry.stored);
    });

  const recordRejected: JiraUserCredentials["Service"]["recordRejected"] = (identity, message) => {
    const personal = identity.personal;
    return personal === undefined
      ? Effect.void
      : exclusive(personal.userId)(
          writeLastError(personal.userId, personal.createdAt, message).pipe(
            Effect.ensuring(invalidate(personal.userId)),
          ),
        );
  };

  return JiraUserCredentials.of({ set, test, clear, get, identityFor, recordRejected });
});

export const layer = Layer.effect(JiraUserCredentials, make);
