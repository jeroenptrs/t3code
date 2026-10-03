import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  AuthClientMetadataDeviceType,
  AuthEnvironmentScopes,
  AuthSessionId,
  AuthUserId,
  AuthUserRole,
  AuthUserStatus,
  ClientSurface,
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
  userId: Schema.optionalKey(AuthUserId),
});
export type CreateAuthSessionInput = typeof CreateAuthSessionInput.Type;

export const CreateReplacingActiveAuthSessionInput = Schema.Struct({
  session: CreateAuthSessionInput,
  revokedAt: Schema.DateTimeUtcFromString,
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

export const SetAuthSessionLastConnectedAtInput = Schema.Struct({
  sessionId: AuthSessionId,
  lastConnectedAt: Schema.DateTimeUtcFromString,
});
export type SetAuthSessionLastConnectedAtInput = typeof SetAuthSessionLastConnectedAtInput.Type;

export const SetAuthSessionClientConnectionInput = Schema.Struct({
  sessionId: AuthSessionId,
  surface: Schema.NullOr(ClientSurface),
  appVersion: Schema.NullOr(Schema.String),
});
export type SetAuthSessionClientConnectionInput = typeof SetAuthSessionClientConnectionInput.Type;

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
    readonly revoke: (
      input: RevokeAuthSessionInput,
    ) => Effect.Effect<boolean, AuthSessionRepositoryError>;
    readonly revokeAllExcept: (
      input: RevokeOtherAuthSessionsInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionId>, AuthSessionRepositoryError>;
    readonly revokeAllForUser: (
      input: RevokeUserAuthSessionsInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionId>, AuthSessionRepositoryError>;
    readonly setLastConnectedAt: (
      input: SetAuthSessionLastConnectedAtInput,
    ) => Effect.Effect<void, AuthSessionRepositoryError>;
    readonly setClientConnection: (
      input: SetAuthSessionClientConnectionInput,
    ) => Effect.Effect<void, AuthSessionRepositoryError>;
  }
>()("t3/persistence/AuthSessions/AuthSessionRepository") {}

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

/** @public Service construction is part of the canonical Effect module API. */
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
    execute: ({ session, revokedAt }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE subject = ${session.subject}
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

  // COALESCE keeps the previous value when a client reports only one field, so
  // a partial report never nulls out data a fuller client stored earlier.
  const setClientConnectionRow = SqlSchema.void({
    Request: SetAuthSessionClientConnectionInput,
    execute: ({ sessionId, surface, appVersion }) =>
      sql`
        UPDATE auth_sessions
        SET client_surface = COALESCE(${surface}, client_surface),
            client_app_version = COALESCE(${appVersion}, client_app_version)
        WHERE session_id = ${sessionId}
          AND revoked_at IS NULL
      `,
  });

  const revokeSessionRows = SqlSchema.findAll({
    Request: RevokeAuthSessionInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ sessionId, revokedAt }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE session_id = ${sessionId}
          AND revoked_at IS NULL
        RETURNING session_id AS "sessionId"
      `,
  });

  const revokeOtherSessionRows = SqlSchema.findAll({
    Request: RevokeOtherAuthSessionsInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ currentSessionId, revokedAt }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE session_id <> ${currentSessionId}
          AND revoked_at IS NULL
        RETURNING session_id AS "sessionId"
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
    revokeSessionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.revoke:query",
          "AuthSessionRepository.revoke:decodeRows",
          { sessionId: input.sessionId },
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const revokeAllExcept: AuthSessionRepository["Service"]["revokeAllExcept"] = (input) =>
    revokeOtherSessionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.revokeAllExcept:query",
          "AuthSessionRepository.revokeAllExcept:decodeRows",
          { currentSessionId: input.currentSessionId },
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.sessionId)),
    );

  const revokeAllForUser: AuthSessionRepository["Service"]["revokeAllForUser"] = (input) =>
    revokeUserSessionRows(input).pipe(
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

  const setClientConnection: AuthSessionRepository["Service"]["setClientConnection"] = (input) =>
    setClientConnectionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.setClientConnection:query",
          "AuthSessionRepository.setClientConnection:encodeRequest",
          { sessionId: input.sessionId },
        ),
      ),
    );

  return {
    create,
    createReplacingActive,
    createIfAbsent,
    getById,
    listActive,
    revoke,
    revokeAllExcept,
    revokeAllForUser,
    setLastConnectedAt,
    setClientConnection,
  } satisfies AuthSessionRepository["Service"];
});

export const layer = Layer.effect(AuthSessionRepository, make);
