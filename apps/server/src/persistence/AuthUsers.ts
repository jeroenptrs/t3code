import {
  AuthUserId,
  AuthUserRole,
  AuthUserStatus,
  EntraGuid,
  type AuthUser,
  type AuthUserAccessActor,
  type AuthUserAccessChange,
  type AuthUserIdentity,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  type AuthUserRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

const AuthUserRow = Schema.Struct({
  userId: AuthUserId,
  tenantId: EntraGuid,
  objectId: EntraGuid,
  status: AuthUserStatus,
  role: Schema.NullOr(AuthUserRole),
  email: Schema.NullOr(Schema.String),
  displayName: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  lastSignInAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
type AuthUserRow = typeof AuthUserRow.Type;

const AuthUserAccessChangeRow = Schema.Struct({
  sequence: Schema.Number,
  userId: AuthUserId,
  actorType: Schema.Literals(["user", "host-cli"]),
  actorUserId: Schema.NullOr(AuthUserId),
  previousStatus: Schema.NullOr(AuthUserStatus),
  status: AuthUserStatus,
  previousRole: Schema.NullOr(AuthUserRole),
  role: Schema.NullOr(AuthUserRole),
  changedAt: Schema.DateTimeUtcFromString,
});
type AuthUserAccessChangeRow = typeof AuthUserAccessChangeRow.Type;

const RecordSignInRequest = Schema.Struct({
  userId: AuthUserId,
  tenantId: Schema.String,
  objectId: Schema.String,
  email: Schema.NullOr(Schema.String),
  displayName: Schema.NullOr(Schema.String),
  now: Schema.DateTimeUtcFromString,
});
export type RecordAuthUserSignInInput = typeof RecordSignInRequest.Type;

const InsertRequest = Schema.Struct({
  userId: AuthUserId,
  tenantId: Schema.String,
  objectId: Schema.String,
  status: AuthUserStatus,
  role: Schema.NullOr(AuthUserRole),
  now: Schema.DateTimeUtcFromString,
});
export type InsertAuthUserInput = typeof InsertRequest.Type;

const UpdateAccessRequest = Schema.Struct({
  userId: AuthUserId,
  status: AuthUserStatus,
  role: Schema.NullOr(AuthUserRole),
  updatedAt: Schema.DateTimeUtcFromString,
});
export type UpdateAuthUserAccessInput = typeof UpdateAccessRequest.Type;

const AppendAccessChangeRequest = Schema.Struct({
  userId: AuthUserId,
  actorType: Schema.Literals(["user", "host-cli"]),
  actorUserId: Schema.NullOr(AuthUserId),
  previousStatus: Schema.NullOr(AuthUserStatus),
  status: AuthUserStatus,
  previousRole: Schema.NullOr(AuthUserRole),
  role: Schema.NullOr(AuthUserRole),
  changedAt: Schema.DateTimeUtcFromString,
});

export type AppendAuthUserAccessChangeInput = Omit<AuthUserAccessChange, "sequence">;

const toAuthUser = (row: AuthUserRow): AuthUser => ({
  userId: row.userId,
  identity: { tenantId: row.tenantId, objectId: row.objectId },
  status: row.status,
  role: row.role,
  email: row.email,
  displayName: row.displayName,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  lastSignInAt: row.lastSignInAt,
});

const toAccessChange = (row: AuthUserAccessChangeRow): AuthUserAccessChange => ({
  sequence: row.sequence,
  userId: row.userId,
  actor:
    row.actorType === "user" && row.actorUserId !== null
      ? { type: "user", userId: row.actorUserId }
      : { type: "host-cli" },
  previousStatus: row.previousStatus,
  status: row.status,
  previousRole: row.previousRole,
  role: row.role,
  changedAt: row.changedAt,
});

const toActorColumns = (actor: AuthUserAccessActor) =>
  actor.type === "user"
    ? ({ actorType: "user", actorUserId: actor.userId } as const)
    : ({ actorType: "host-cli", actorUserId: null } as const);

export class AuthUserRepository extends Context.Service<
  AuthUserRepository,
  {
    /** Creates a pending user or refreshes the labels of an existing one. Never touches status or role. */
    readonly recordSignIn: (
      input: RecordAuthUserSignInInput,
    ) => Effect.Effect<AuthUser, AuthUserRepositoryError>;
    readonly insert: (
      input: InsertAuthUserInput,
    ) => Effect.Effect<AuthUser, AuthUserRepositoryError>;
    readonly getById: (
      userId: AuthUserId,
    ) => Effect.Effect<Option.Option<AuthUser>, AuthUserRepositoryError>;
    readonly getByIdentity: (
      identity: AuthUserIdentity,
    ) => Effect.Effect<Option.Option<AuthUser>, AuthUserRepositoryError>;
    readonly list: () => Effect.Effect<ReadonlyArray<AuthUser>, AuthUserRepositoryError>;
    readonly countActiveAdministrators: () => Effect.Effect<number, AuthUserRepositoryError>;
    readonly updateAccess: (
      input: UpdateAuthUserAccessInput,
    ) => Effect.Effect<AuthUser, AuthUserRepositoryError>;
    readonly appendAccessChange: (
      input: AppendAuthUserAccessChangeInput,
    ) => Effect.Effect<AuthUserAccessChange, AuthUserRepositoryError>;
    readonly listAccessChanges: (input: {
      readonly userId?: AuthUserId;
    }) => Effect.Effect<ReadonlyArray<AuthUserAccessChange>, AuthUserRepositoryError>;
  }
>()("t3/persistence/AuthUsers/AuthUserRepository") {}

const toRepositoryError =
  (operation: string) =>
  (cause: unknown): AuthUserRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : new PersistenceSqlError({ operation, cause });

const USER_COLUMNS = `
  user_id AS "userId",
  tenant_id AS "tenantId",
  object_id AS "objectId",
  status AS "status",
  role AS "role",
  email AS "email",
  display_name AS "displayName",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  last_sign_in_at AS "lastSignInAt"
`;

const ACCESS_CHANGE_COLUMNS = `
  sequence AS "sequence",
  user_id AS "userId",
  actor_type AS "actorType",
  actor_user_id AS "actorUserId",
  previous_status AS "previousStatus",
  status AS "status",
  previous_role AS "previousRole",
  role AS "role",
  changed_at AS "changedAt"
`;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const userColumns = sql.literal(USER_COLUMNS);
  const accessChangeColumns = sql.literal(ACCESS_CHANGE_COLUMNS);

  const recordSignInRow = SqlSchema.findOne({
    Request: RecordSignInRequest,
    Result: AuthUserRow,
    execute: (input) => sql`
      INSERT INTO auth_users (
        user_id, tenant_id, object_id, status, role, email, display_name,
        created_at, updated_at, last_sign_in_at
      )
      VALUES (
        ${input.userId}, ${input.tenantId}, ${input.objectId}, 'pending', NULL,
        ${input.email}, ${input.displayName}, ${input.now}, ${input.now}, ${input.now}
      )
      ON CONFLICT (tenant_id, object_id) DO UPDATE SET
        email = excluded.email,
        display_name = excluded.display_name,
        updated_at = excluded.updated_at,
        last_sign_in_at = excluded.last_sign_in_at
      RETURNING ${userColumns}
    `,
  });

  const insertRow = SqlSchema.findOne({
    Request: InsertRequest,
    Result: AuthUserRow,
    execute: (input) => sql`
      INSERT INTO auth_users (
        user_id, tenant_id, object_id, status, role, email, display_name,
        created_at, updated_at, last_sign_in_at
      )
      VALUES (
        ${input.userId}, ${input.tenantId}, ${input.objectId}, ${input.status}, ${input.role},
        NULL, NULL, ${input.now}, ${input.now}, NULL
      )
      RETURNING ${userColumns}
    `,
  });

  const getRowById = SqlSchema.findOneOption({
    Request: AuthUserId,
    Result: AuthUserRow,
    execute: (userId) => sql`SELECT ${userColumns} FROM auth_users WHERE user_id = ${userId}`,
  });

  const getRowByIdentity = SqlSchema.findOneOption({
    Request: Schema.Struct({ tenantId: Schema.String, objectId: Schema.String }),
    Result: AuthUserRow,
    execute: ({ tenantId, objectId }) => sql`
      SELECT ${userColumns} FROM auth_users
      WHERE tenant_id = ${tenantId} AND object_id = ${objectId}
    `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AuthUserRow,
    execute: () => sql`SELECT ${userColumns} FROM auth_users ORDER BY created_at ASC, user_id ASC`,
  });

  const countActiveAdministratorRows = SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: () => sql`
      SELECT COUNT(*) AS "count" FROM auth_users
      WHERE status = 'active' AND role = 'administrator'
    `,
  });

  const updateAccessRow = SqlSchema.findOne({
    Request: UpdateAccessRequest,
    Result: AuthUserRow,
    execute: (input) => sql`
      UPDATE auth_users
      SET status = ${input.status}, role = ${input.role}, updated_at = ${input.updatedAt}
      WHERE user_id = ${input.userId}
      RETURNING ${userColumns}
    `,
  });

  const appendAccessChangeRow = SqlSchema.findOne({
    Request: AppendAccessChangeRequest,
    Result: AuthUserAccessChangeRow,
    execute: (input) => sql`
      INSERT INTO auth_user_access_changes (
        user_id, actor_type, actor_user_id, previous_status, status,
        previous_role, role, changed_at
      )
      VALUES (
        ${input.userId}, ${input.actorType}, ${input.actorUserId}, ${input.previousStatus},
        ${input.status}, ${input.previousRole}, ${input.role}, ${input.changedAt}
      )
      RETURNING ${accessChangeColumns}
    `,
  });

  const listAccessChangeRows = SqlSchema.findAll({
    Request: Schema.NullOr(AuthUserId),
    Result: AuthUserAccessChangeRow,
    execute: (userId) =>
      userId === null
        ? sql`SELECT ${accessChangeColumns} FROM auth_user_access_changes ORDER BY sequence DESC`
        : sql`
            SELECT ${accessChangeColumns} FROM auth_user_access_changes
            WHERE user_id = ${userId}
            ORDER BY sequence DESC
          `,
  });

  return AuthUserRepository.of({
    recordSignIn: (input) =>
      recordSignInRow(input).pipe(
        Effect.map(toAuthUser),
        Effect.mapError(toRepositoryError("AuthUserRepository.recordSignIn")),
      ),
    insert: (input) =>
      insertRow(input).pipe(
        Effect.map(toAuthUser),
        Effect.mapError(toRepositoryError("AuthUserRepository.insert")),
      ),
    getById: (userId) =>
      getRowById(userId).pipe(
        Effect.map(Option.map(toAuthUser)),
        Effect.mapError(toRepositoryError("AuthUserRepository.getById")),
      ),
    getByIdentity: (identity) =>
      getRowByIdentity(identity).pipe(
        Effect.map(Option.map(toAuthUser)),
        Effect.mapError(toRepositoryError("AuthUserRepository.getByIdentity")),
      ),
    list: () =>
      listRows(undefined).pipe(
        Effect.map((rows) => rows.map(toAuthUser)),
        Effect.mapError(toRepositoryError("AuthUserRepository.list")),
      ),
    countActiveAdministrators: () =>
      countActiveAdministratorRows(undefined).pipe(
        Effect.map((row) => row.count),
        Effect.mapError(toRepositoryError("AuthUserRepository.countActiveAdministrators")),
      ),
    updateAccess: (input) =>
      updateAccessRow(input).pipe(
        Effect.map(toAuthUser),
        Effect.mapError(toRepositoryError("AuthUserRepository.updateAccess")),
      ),
    appendAccessChange: ({ actor, ...change }) =>
      appendAccessChangeRow({ ...change, ...toActorColumns(actor) }).pipe(
        Effect.map(toAccessChange),
        Effect.mapError(toRepositoryError("AuthUserRepository.appendAccessChange")),
      ),
    listAccessChanges: (input) =>
      listAccessChangeRows(input.userId ?? null).pipe(
        Effect.map((rows) => rows.map(toAccessChange)),
        Effect.mapError(toRepositoryError("AuthUserRepository.listAccessChanges")),
      ),
  });
});

export const layer = Layer.effect(AuthUserRepository, make);
