import * as Context from "effect/Context";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  AuthClientMetadataDeviceType,
  AuthEnvironmentScopes,
  AuthSessionId,
  AuthUserId,
  AuthUserRole,
  AuthUserStatus,
  ServerAuthSessionMethod,
} from "@t3tools/contracts";

import {
  type AuthSessionRepositoryError,
  PersistenceDecodeError,
  type PersistenceErrorCorrelation,
  PersistenceSqlError,
} from "./Errors.ts";

export const AuthSessionClientMetadataRecord = Schema.Struct({
  label: Schema.NullOr(Schema.String),
  ipAddress: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  deviceType: AuthClientMetadataDeviceType,
  os: Schema.NullOr(Schema.String),
  browser: Schema.NullOr(Schema.String),
});
export type AuthSessionClientMetadataRecord = typeof AuthSessionClientMetadataRecord.Type;

/** The portal user a session belongs to, read with the session in one query. */
export const AuthSessionUserRecord = Schema.Struct({
  userId: AuthUserId,
  status: AuthUserStatus,
  role: Schema.NullOr(AuthUserRole),
  email: Schema.NullOr(Schema.String),
  displayName: Schema.NullOr(Schema.String),
});
export type AuthSessionUserRecord = typeof AuthSessionUserRecord.Type;

export const AuthSessionRecord = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  scopes: AuthEnvironmentScopes,
  method: ServerAuthSessionMethod,
  client: AuthSessionClientMetadataRecord,
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  user: Schema.NullOr(AuthSessionUserRecord),
});
export type AuthSessionRecord = typeof AuthSessionRecord.Type;

export const CreateAuthSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  scopes: AuthEnvironmentScopes,
  method: ServerAuthSessionMethod,
  client: AuthSessionClientMetadataRecord,
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  proofKeyThumbprint: Schema.optionalKey(Schema.String),
  userId: Schema.optionalKey(AuthUserId),
});
export type CreateAuthSessionInput = typeof CreateAuthSessionInput.Type;

export const CreateReplacingActiveAuthSessionInput = Schema.Struct({
  session: CreateAuthSessionInput,
  revokedAt: Schema.DateTimeUtcFromString,
  replaceSessionId: Schema.optionalKey(AuthSessionId),
});
export type CreateReplacingActiveAuthSessionInput =
  typeof CreateReplacingActiveAuthSessionInput.Type;

export const GetAuthSessionByIdInput = Schema.Struct({
  sessionId: AuthSessionId,
});
export type GetAuthSessionByIdInput = typeof GetAuthSessionByIdInput.Type;

export const ListActiveAuthSessionsInput = Schema.Struct({
  now: Schema.DateTimeUtcFromString,
  connectedSessionIds: Schema.optionalKey(Schema.Array(AuthSessionId)),
});
export type ListActiveAuthSessionsInput = typeof ListActiveAuthSessionsInput.Type;

export const RevokeAuthSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeAuthSessionInput = typeof RevokeAuthSessionInput.Type;

export const RevokeOtherAuthSessionsInput = Schema.Struct({
  currentSessionId: AuthSessionId,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeOtherAuthSessionsInput = typeof RevokeOtherAuthSessionsInput.Type;

export const RevokeUserAuthSessionsInput = Schema.Struct({
  userId: AuthUserId,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeUserAuthSessionsInput = typeof RevokeUserAuthSessionsInput.Type;

export const BindAuthSessionUserInput = Schema.Struct({
  sessionId: AuthSessionId,
  userId: AuthUserId,
  now: Schema.DateTimeUtcFromString,
  latestExpiresAt: Schema.DateTimeUtcFromString,
  /** Also binds this device key until `latestExpiresAt`, so its renewed sessions inherit the user. */
  proofKeyThumbprint: Schema.optionalKey(Schema.String),
});
export type BindAuthSessionUserInput = typeof BindAuthSessionUserInput.Type;

export const UnbindAuthSessionUserInput = Schema.Struct({
  sessionId: AuthSessionId,
  proofKeyThumbprint: Schema.optionalKey(Schema.String),
});
export type UnbindAuthSessionUserInput = typeof UnbindAuthSessionUserInput.Type;

export interface RevokeAuthSessionResult {
  readonly revoked: boolean;
  /** Sessions still active that lost their user because the device's step-up ended. */
  readonly unboundSessionIds: ReadonlyArray<AuthSessionId>;
}

export const CreateInheritingStepUpInput = Schema.Struct({
  session: CreateAuthSessionInput,
  proofKeyThumbprint: Schema.String,
});
export type CreateInheritingStepUpInput = typeof CreateInheritingStepUpInput.Type;

const StepUpBindingRequest = Schema.Struct({
  proofKeyThumbprint: Schema.String,
  userId: AuthUserId,
  expiresAt: Schema.DateTimeUtcFromString,
  now: Schema.DateTimeUtcFromString,
});

export const RevokeAuthSessionsByProofKeyInput = Schema.Struct({
  proofKeyThumbprint: Schema.String,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeAuthSessionsByProofKeyInput = typeof RevokeAuthSessionsByProofKeyInput.Type;

export const SetAuthSessionLastConnectedAtInput = Schema.Struct({
  sessionId: AuthSessionId,
  lastConnectedAt: Schema.DateTimeUtcFromString,
});
export type SetAuthSessionLastConnectedAtInput = typeof SetAuthSessionLastConnectedAtInput.Type;

export class AuthSessionRepository extends Context.Service<
  AuthSessionRepository,
  {
    readonly create: (
      input: CreateAuthSessionInput,
    ) => Effect.Effect<void, AuthSessionRepositoryError>;
    readonly createReplacingActive: (
      input: CreateReplacingActiveAuthSessionInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionId>, AuthSessionRepositoryError>;
    readonly createIfAbsent: (
      input: CreateAuthSessionInput,
    ) => Effect.Effect<void, AuthSessionRepositoryError>;
    readonly getById: (
      input: GetAuthSessionByIdInput,
    ) => Effect.Effect<Option.Option<AuthSessionRecord>, AuthSessionRepositoryError>;
    readonly listActive: (
      input: ListActiveAuthSessionsInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionRecord>, AuthSessionRepositoryError>;
    /** Revoking a stepped-up session ends its device's step-up, unbinding the key's other sessions. */
    readonly revoke: (
      input: RevokeAuthSessionInput,
    ) => Effect.Effect<RevokeAuthSessionResult, AuthSessionRepositoryError>;
    readonly revokeAllExcept: (
      input: RevokeOtherAuthSessionsInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionId>, AuthSessionRepositoryError>;
    readonly revokeAllForUser: (
      input: RevokeUserAuthSessionsInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionId>, AuthSessionRepositoryError>;
    readonly setLastConnectedAt: (
      input: SetAuthSessionLastConnectedAtInput,
    ) => Effect.Effect<void, AuthSessionRepositoryError>;
    /**
     * Binds an active session that has no user, shortening its expiry to
     * `latestExpiresAt` when that is sooner. False when nothing matched.
     */
    readonly bindUser: (
      input: BindAuthSessionUserInput,
    ) => Effect.Effect<boolean, AuthSessionRepositoryError>;
    /** Clears a session's user and ends its device's step-up. Returns the sessions it unbound. */
    readonly unbindUser: (
      input: UnbindAuthSessionUserInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionId>, AuthSessionRepositoryError>;
    /**
     * Creates a session that takes the user of a live binding for its device
     * key, capped at the binding's expiry. Returns the user, or null.
     */
    readonly createInheritingStepUp: (
      input: CreateInheritingStepUpInput,
    ) => Effect.Effect<AuthUserId | null, AuthSessionRepositoryError>;
    readonly getProofKeyThumbprint: (
      input: GetAuthSessionByIdInput,
    ) => Effect.Effect<Option.Option<string>, AuthSessionRepositoryError>;
    readonly revokeByProofKey: (
      input: RevokeAuthSessionsByProofKeyInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionId>, AuthSessionRepositoryError>;
  }
>()("t3/persistence/AuthSessions/AuthSessionRepository") {}

const RevokedSessionRow = Schema.Struct({
  sessionId: AuthSessionId,
  stepUpProofKey: Schema.NullOr(Schema.String),
});

const AuthSessionDbRow = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  scopes: Schema.fromJsonString(AuthEnvironmentScopes),
  method: ServerAuthSessionMethod,
  clientLabel: Schema.NullOr(Schema.String),
  clientIpAddress: Schema.NullOr(Schema.String),
  clientUserAgent: Schema.NullOr(Schema.String),
  clientDeviceType: Schema.Literals(["desktop", "mobile", "tablet", "bot", "unknown"]),
  clientOs: Schema.NullOr(Schema.String),
  clientBrowser: Schema.NullOr(Schema.String),
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  userId: Schema.NullOr(AuthUserId),
  userStatus: Schema.NullOr(AuthUserStatus),
  userRole: Schema.NullOr(AuthUserRole),
  userEmail: Schema.NullOr(Schema.String),
  userDisplayName: Schema.NullOr(Schema.String),
});

const AuthSessionRawDbRow = Schema.Struct({
  sessionId: Schema.String,
  subject: Schema.Unknown,
  scopes: Schema.Unknown,
  method: Schema.Unknown,
  clientLabel: Schema.Unknown,
  clientIpAddress: Schema.Unknown,
  clientUserAgent: Schema.Unknown,
  clientDeviceType: Schema.Unknown,
  clientOs: Schema.Unknown,
  clientBrowser: Schema.Unknown,
  issuedAt: Schema.Unknown,
  expiresAt: Schema.Unknown,
  lastConnectedAt: Schema.Unknown,
  revokedAt: Schema.Unknown,
  userId: Schema.Unknown,
  userStatus: Schema.Unknown,
  userRole: Schema.Unknown,
  userEmail: Schema.Unknown,
  userDisplayName: Schema.Unknown,
});

const decodeAuthSessionDbRow = Schema.decodeUnknownEffect(AuthSessionDbRow);

function toAuthSessionRecord(row: typeof AuthSessionDbRow.Type): AuthSessionRecord {
  return {
    sessionId: row.sessionId,
    subject: row.subject,
    scopes: row.scopes,
    method: row.method,
    client: {
      label: row.clientLabel,
      ipAddress: row.clientIpAddress,
      userAgent: row.clientUserAgent,
      deviceType: row.clientDeviceType,
      os: row.clientOs,
      browser: row.clientBrowser,
    },
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    lastConnectedAt: row.lastConnectedAt,
    revokedAt: row.revokedAt,
    // The foreign key keeps the joined user present whenever user_id is set.
    user:
      row.userId === null || row.userStatus === null
        ? null
        : {
            userId: row.userId,
            status: row.userStatus,
            role: row.userRole,
            email: row.userEmail,
            displayName: row.userDisplayName,
          },
  };
}

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): AuthSessionRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOperation,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });
}

/** @public */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Every session read joins its user, so verifying a session resolves the
  // user's current access in the same query.
  const sessionColumns = sql.literal(`
    s.session_id AS "sessionId",
    s.subject AS "subject",
    s.scopes AS "scopes",
    s.method AS "method",
    s.client_label AS "clientLabel",
    s.client_ip_address AS "clientIpAddress",
    s.client_user_agent AS "clientUserAgent",
    s.client_device_type AS "clientDeviceType",
    s.client_os AS "clientOs",
    s.client_browser AS "clientBrowser",
    s.issued_at AS "issuedAt",
    s.expires_at AS "expiresAt",
    s.last_connected_at AS "lastConnectedAt",
    s.revoked_at AS "revokedAt",
    s.user_id AS "userId",
    u.status AS "userStatus",
    u.role AS "userRole",
    u.email AS "userEmail",
    u.display_name AS "userDisplayName"
  `);

  const insertSessionRow = (ignoreExisting: boolean) =>
    SqlSchema.void({
      Request: CreateAuthSessionInput,
      execute: (input) =>
        sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          scopes,
          method,
          client_label,
          client_ip_address,
          client_user_agent,
          client_device_type,
          client_os,
          client_browser,
          issued_at,
          expires_at,
          revoked_at,
          proof_key_thumbprint,
          user_id
        )
        VALUES (
          ${input.sessionId},
          ${input.subject},
          ${JSON.stringify(input.scopes)},
          ${input.method},
          ${input.client.label},
          ${input.client.ipAddress},
          ${input.client.userAgent},
          ${input.client.deviceType},
          ${input.client.os},
          ${input.client.browser},
          ${input.issuedAt},
          ${input.expiresAt},
          NULL,
          ${input.proofKeyThumbprint ?? null},
          ${input.userId ?? null}
        )
        ${ignoreExisting ? sql`ON CONFLICT(session_id) DO NOTHING` : sql``}
      `,
    });
  const createSessionRow = insertSessionRow(false);
  const createSessionRowIfAbsent = insertSessionRow(true);

  const getSessionRowById = SqlSchema.findOneOption({
    Request: GetAuthSessionByIdInput,
    Result: AuthSessionRawDbRow,
    execute: ({ sessionId }) =>
      sql`
        SELECT ${sessionColumns}
        FROM auth_sessions s
        LEFT JOIN auth_users u ON u.user_id = s.user_id
        WHERE s.session_id = ${sessionId}
      `,
  });

  const revokeActiveSessionsForReplacement = SqlSchema.findAll({
    Request: CreateReplacingActiveAuthSessionInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ session, revokedAt, replaceSessionId }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE ${
          replaceSessionId === undefined
            ? sql`subject = ${session.subject}`
            : sql`session_id = ${replaceSessionId}`
        }
          AND method = ${session.method}
          AND revoked_at IS NULL
          AND expires_at > ${revokedAt}
        RETURNING session_id AS "sessionId"
      `,
  });

  const listActiveSessionRows = SqlSchema.findAll({
    Request: ListActiveAuthSessionsInput,
    Result: AuthSessionRawDbRow,
    execute: ({ now, connectedSessionIds = [] }) =>
      sql`
        SELECT ${sessionColumns}
        FROM auth_sessions s
        LEFT JOIN auth_users u ON u.user_id = s.user_id
        WHERE s.revoked_at IS NULL
          AND (s.expires_at > ${now} OR ${sql.in("s.session_id", connectedSessionIds)})
        ORDER BY s.issued_at DESC, s.session_id DESC
      `,
  });

  const setLastConnectedAtRow = SqlSchema.void({
    Request: SetAuthSessionLastConnectedAtInput,
    execute: ({ sessionId, lastConnectedAt }) =>
      sql`
        UPDATE auth_sessions
        SET last_connected_at = ${lastConnectedAt}
        WHERE session_id = ${sessionId}
          AND revoked_at IS NULL
      `,
  });

  const revokeSessionRows = SqlSchema.findAll({
    Request: RevokeAuthSessionInput,
    Result: RevokedSessionRow,
    execute: ({ sessionId, revokedAt }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE session_id = ${sessionId}
          AND revoked_at IS NULL
        RETURNING session_id AS "sessionId", step_up_proof_key AS "stepUpProofKey"
      `,
  });

  const proofKeyThumbprintRows = SqlSchema.findAll({
    Request: GetAuthSessionByIdInput,
    Result: Schema.Struct({ proofKeyThumbprint: Schema.String }),
    execute: ({ sessionId }) =>
      sql`
        SELECT proof_key_thumbprint AS "proofKeyThumbprint"
        FROM auth_sessions
        WHERE session_id = ${sessionId}
          AND proof_key_thumbprint IS NOT NULL
      `,
  });

  const revokeByProofKeyRows = SqlSchema.findAll({
    Request: RevokeAuthSessionsByProofKeyInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ proofKeyThumbprint, revokedAt }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE proof_key_thumbprint = ${proofKeyThumbprint}
          AND revoked_at IS NULL
        RETURNING session_id AS "sessionId"
      `,
  });

  const revokeOtherSessionRows = SqlSchema.findAll({
    Request: RevokeOtherAuthSessionsInput,
    Result: RevokedSessionRow,
    execute: ({ currentSessionId, revokedAt }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE session_id <> ${currentSessionId}
          AND revoked_at IS NULL
        RETURNING session_id AS "sessionId", step_up_proof_key AS "stepUpProofKey"
      `,
  });

  const revokeUserSessionRows = SqlSchema.findAll({
    Request: RevokeUserAuthSessionsInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ userId, revokedAt }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE user_id = ${userId}
          AND revoked_at IS NULL
        RETURNING session_id AS "sessionId"
      `,
  });

  const bindUserRows = SqlSchema.findAll({
    Request: BindAuthSessionUserInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ sessionId, userId, now, latestExpiresAt, proofKeyThumbprint }) =>
      sql`
        UPDATE auth_sessions
        SET user_id = ${userId},
          step_up_proof_key = ${proofKeyThumbprint ?? null},
          expires_at = MIN(expires_at, ${latestExpiresAt})
        WHERE session_id = ${sessionId}
          AND user_id IS NULL
          AND revoked_at IS NULL
          AND expires_at > ${now}
        RETURNING session_id AS "sessionId"
      `,
  });

  const writeStepUpBinding = SqlSchema.void({
    Request: StepUpBindingRequest,
    execute: ({ proofKeyThumbprint, userId, expiresAt, now }) =>
      sql`
        DELETE FROM fork_auth_step_up_bindings WHERE expires_at <= ${now}
      `.pipe(
        Effect.andThen(
          sql`
            INSERT INTO fork_auth_step_up_bindings (proof_key_thumbprint, user_id, expires_at)
            VALUES (${proofKeyThumbprint}, ${userId}, ${expiresAt})
            ON CONFLICT(proof_key_thumbprint) DO UPDATE SET
              user_id = excluded.user_id,
              expires_at = excluded.expires_at
          `,
        ),
      ),
  });

  const unbindDeviceSessionRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: (proofKeyThumbprint) =>
      sql`
        UPDATE auth_sessions
        SET user_id = NULL, step_up_proof_key = NULL
        WHERE step_up_proof_key = ${proofKeyThumbprint}
          AND revoked_at IS NULL
        RETURNING session_id AS "sessionId"
      `,
  });

  const deleteStepUpBinding = (proofKeyThumbprint: string) =>
    sql`DELETE FROM fork_auth_step_up_bindings WHERE proof_key_thumbprint = ${proofKeyThumbprint}`;

  /** Stops the key's renewals inheriting a user and drops the user from its active sessions. */
  const endDeviceStepUp = (proofKeyThumbprint: string) =>
    deleteStepUpBinding(proofKeyThumbprint).pipe(
      Effect.andThen(unbindDeviceSessionRows(proofKeyThumbprint)),
      Effect.map((rows) => rows.map((row) => row.sessionId)),
    );

  // One statement, so a binding deleted by a concurrent revocation is either
  // seen and inherited before it, or not at all.
  const insertInheritingStepUp = SqlSchema.findAll({
    Request: CreateInheritingStepUpInput,
    Result: Schema.Struct({ userId: Schema.NullOr(AuthUserId) }),
    execute: ({ session, proofKeyThumbprint }) =>
      sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          scopes,
          method,
          client_label,
          client_ip_address,
          client_user_agent,
          client_device_type,
          client_os,
          client_browser,
          issued_at,
          expires_at,
          revoked_at,
          proof_key_thumbprint,
          user_id,
          step_up_proof_key
        )
        SELECT
          ${session.sessionId},
          ${session.subject},
          ${JSON.stringify(session.scopes)},
          ${session.method},
          ${session.client.label},
          ${session.client.ipAddress},
          ${session.client.userAgent},
          ${session.client.deviceType},
          ${session.client.os},
          ${session.client.browser},
          ${session.issuedAt},
          CASE
            WHEN b.expires_at IS NOT NULL AND b.expires_at < ${session.expiresAt} THEN b.expires_at
            ELSE ${session.expiresAt}
          END,
          NULL,
          ${session.proofKeyThumbprint ?? null},
          b.user_id,
          b.proof_key_thumbprint
        FROM (SELECT 1) AS one
        LEFT JOIN fork_auth_step_up_bindings b
          ON b.proof_key_thumbprint = ${proofKeyThumbprint}
          AND b.expires_at > ${session.issuedAt}
        RETURNING user_id AS "userId"
      `,
  });

  const unbindUserRows = SqlSchema.findAll({
    Request: GetAuthSessionByIdInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ sessionId }) =>
      sql`
        UPDATE auth_sessions
        SET user_id = NULL, step_up_proof_key = NULL
        WHERE session_id = ${sessionId}
          AND user_id IS NOT NULL
          AND revoked_at IS NULL
        RETURNING session_id AS "sessionId"
      `,
  });

  const create: AuthSessionRepository["Service"]["create"] = (input) =>
    createSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.create:query",
          "AuthSessionRepository.create:encodeRequest",
          { sessionId: input.sessionId },
        ),
      ),
    );

  const createReplacingActive: AuthSessionRepository["Service"]["createReplacingActive"] = (
    input,
  ) =>
    sql
      .withTransaction(
        revokeActiveSessionsForReplacement(input).pipe(
          Effect.flatMap((revokedRows) =>
            createSessionRow(input.session).pipe(
              Effect.as(revokedRows.map((row) => row.sessionId)),
            ),
          ),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "AuthSessionRepository.createReplacingActive:query",
            "AuthSessionRepository.createReplacingActive:encodeRequest",
            { sessionId: input.session.sessionId },
          ),
        ),
      );

  const createIfAbsent: AuthSessionRepository["Service"]["createIfAbsent"] = (input) =>
    createSessionRowIfAbsent(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.createIfAbsent:query",
          "AuthSessionRepository.createIfAbsent:encodeRequest",
          { sessionId: input.sessionId },
        ),
      ),
    );

  const getById: AuthSessionRepository["Service"]["getById"] = (input) =>
    getSessionRowById(input).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.getById:query",
          "AuthSessionRepository.getById:decodeRow",
          { sessionId: input.sessionId },
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeedNone,
          onSome: (row) =>
            decodeAuthSessionDbRow(row).pipe(
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError(
                  "AuthSessionRepository.getById:decodeRow",
                  cause,
                  { sessionId: input.sessionId },
                ),
              ),
              Effect.map((decodedRow) => Option.some(toAuthSessionRecord(decodedRow))),
            ),
        }),
      ),
    );

  const listActive: AuthSessionRepository["Service"]["listActive"] = (input) =>
    listActiveSessionRows(input).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.listActive:query",
          "AuthSessionRepository.listActive:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeAuthSessionDbRow(row).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(
                "AuthSessionRepository.listActive:decodeRows",
                cause,
                { sessionId: row.sessionId },
              ),
            ),
            Effect.map(toAuthSessionRecord),
          ),
        ),
      ),
    );

  const revoke: AuthSessionRepository["Service"]["revoke"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [row] = yield* revokeSessionRows(input);
          const unboundSessionIds = row?.stepUpProofKey
            ? yield* endDeviceStepUp(row.stepUpProofKey)
            : [];
          return { revoked: row !== undefined, unboundSessionIds };
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "AuthSessionRepository.revoke:query",
            "AuthSessionRepository.revoke:decodeRows",
            { sessionId: input.sessionId },
          ),
        ),
      );

  // The caller's own device keeps its step-up, even when an older session of it was revoked.
  const revokeAllExcept: AuthSessionRepository["Service"]["revokeAllExcept"] = (input) =>
    sql
      .withTransaction(
        revokeOtherSessionRows(input).pipe(
          Effect.tap((rows) =>
            Effect.forEach(
              new Set(rows.flatMap((row) => row.stepUpProofKey ?? [])),
              (proofKey) =>
                sql`
                  DELETE FROM fork_auth_step_up_bindings
                  WHERE proof_key_thumbprint = ${proofKey}
                    AND NOT EXISTS (
                      SELECT 1 FROM auth_sessions
                      WHERE session_id = ${input.currentSessionId}
                        AND step_up_proof_key = ${proofKey}
                    )
                `,
              { discard: true },
            ),
          ),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "AuthSessionRepository.revokeAllExcept:query",
            "AuthSessionRepository.revokeAllExcept:decodeRows",
            { currentSessionId: input.currentSessionId },
          ),
        ),
        Effect.map((rows) => rows.map((row) => row.sessionId)),
      );

  // Deleting the user's device bindings with the sessions keeps a renewal from rebinding them.
  const revokeAllForUser: AuthSessionRepository["Service"]["revokeAllForUser"] = (input) =>
    sql
      .withTransaction(
        revokeUserSessionRows(input).pipe(
          Effect.tap(
            () => sql`DELETE FROM fork_auth_step_up_bindings WHERE user_id = ${input.userId}`,
          ),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "AuthSessionRepository.revokeAllForUser:query",
            "AuthSessionRepository.revokeAllForUser:decodeRows",
          ),
        ),
        Effect.map((rows) => rows.map((row) => row.sessionId)),
      );

  const setLastConnectedAt: AuthSessionRepository["Service"]["setLastConnectedAt"] = (input) =>
    setLastConnectedAtRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.setLastConnectedAt:query",
          "AuthSessionRepository.setLastConnectedAt:encodeRequest",
          { sessionId: input.sessionId },
        ),
      ),
    );

  const bindUser: AuthSessionRepository["Service"]["bindUser"] = (input) =>
    sql
      .withTransaction(
        bindUserRows(input).pipe(
          Effect.tap((rows) =>
            rows.length > 0 && input.proofKeyThumbprint !== undefined
              ? writeStepUpBinding({
                  proofKeyThumbprint: input.proofKeyThumbprint,
                  userId: input.userId,
                  expiresAt: input.latestExpiresAt,
                  now: input.now,
                })
              : Effect.void,
          ),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "AuthSessionRepository.bindUser:query",
            "AuthSessionRepository.bindUser:decodeRows",
            { sessionId: input.sessionId },
          ),
        ),
        Effect.map((rows) => rows.length > 0),
      );

  const unbindUser: AuthSessionRepository["Service"]["unbindUser"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* unbindUserRows({ sessionId: input.sessionId });
          const siblings =
            input.proofKeyThumbprint === undefined
              ? []
              : yield* endDeviceStepUp(input.proofKeyThumbprint);
          return [...rows.map((row) => row.sessionId), ...siblings];
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "AuthSessionRepository.unbindUser:query",
            "AuthSessionRepository.unbindUser:decodeRows",
            { sessionId: input.sessionId },
          ),
        ),
      );

  const createInheritingStepUp: AuthSessionRepository["Service"]["createInheritingStepUp"] = (
    input,
  ) =>
    insertInheritingStepUp(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.createInheritingStepUp:query",
          "AuthSessionRepository.createInheritingStepUp:decodeRows",
          { sessionId: input.session.sessionId },
        ),
      ),
      Effect.map((rows) => rows[0]?.userId ?? null),
    );

  const getProofKeyThumbprint: AuthSessionRepository["Service"]["getProofKeyThumbprint"] = (
    input,
  ) =>
    proofKeyThumbprintRows(input).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.getProofKeyThumbprint:query",
          "AuthSessionRepository.getProofKeyThumbprint:decodeRows",
          { sessionId: input.sessionId },
        ),
      ),
      Effect.map((rows) => Option.fromNullishOr(rows[0]?.proofKeyThumbprint)),
    );

  const revokeByProofKey: AuthSessionRepository["Service"]["revokeByProofKey"] = (input) =>
    revokeByProofKeyRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.revokeByProofKey:query",
          "AuthSessionRepository.revokeByProofKey:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.sessionId)),
    );

  return {
    create,
    createReplacingActive,
    createInheritingStepUp,
    createIfAbsent,
    getById,
    listActive,
    revoke,
    revokeAllExcept,
    revokeAllForUser,
    setLastConnectedAt,
    getProofKeyThumbprint,
    revokeByProofKey,
    bindUser,
    unbindUser,
  } satisfies AuthSessionRepository["Service"];
});

export const layer = Layer.effect(AuthSessionRepository, make);
