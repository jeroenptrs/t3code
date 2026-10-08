import {
  AuthUserId,
  AuthUserStatus,
  type AuthUser,
  type AuthUserAccessActor,
  type AuthUserAccessChange,
  type AuthUserIdentity,
  type AuthUserRole,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import * as AuthUsers from "../persistence/AuthUsers.ts";

export class AuthUserNotFoundError extends Schema.TaggedError<AuthUserNotFoundError>()(
  "AuthUserNotFoundError",
  { userId: AuthUserId },
) {
  override get message(): string {
    return `User '${this.userId}' does not exist.`;
  }
}

export class AuthUserTransitionError extends Schema.TaggedError<AuthUserTransitionError>()(
  "AuthUserTransitionError",
  {
    userId: AuthUserId,
    operation: Schema.Literals(["approve", "changeRole", "enable"]),
    status: AuthUserStatus,
  },
) {
  override get message(): string {
    return `Cannot ${this.operation} user '${this.userId}' while it is ${this.status}.`;
  }
}

export class AuthUserRoleRequiredError extends Schema.TaggedError<AuthUserRoleRequiredError>()(
  "AuthUserRoleRequiredError",
  { userId: AuthUserId },
) {
  override get message(): string {
    return `User '${this.userId}' was never approved, so enabling it needs a role.`;
  }
}

export class LastAdministratorError extends Schema.TaggedError<LastAdministratorError>()(
  "LastAdministratorError",
  { userId: AuthUserId },
) {
  override get message(): string {
    return `User '${this.userId}' is the last active administrator. Make another administrator first.`;
  }
}

export class UserRegistryPersistenceError extends Schema.TaggedError<UserRegistryPersistenceError>()(
  "UserRegistryPersistenceError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `User registry operation '${this.operation}' failed.`;
  }
}

/**
 * Published after a committed change to a user's status or role, never for a
 * label refresh. Consumers that hold sessions for `user.userId` should
 * re-derive their scopes with `authUserEffectiveScopes(user)`.
 */
export interface AuthUserAccessChanged {
  readonly user: AuthUser;
  readonly change: AuthUserAccessChange;
}

export class UserRegistry extends Context.Service<
  UserRegistry,
  {
    /**
     * Called after a verified sign-in. Creates a pending user on first sight,
     * otherwise refreshes the email and display-name labels. Status and role
     * are never changed here.
     */
    readonly recordSignIn: (input: {
      readonly identity: AuthUserIdentity;
      readonly email: string | null;
      readonly displayName: string | null;
    }) => Effect.Effect<AuthUser, UserRegistryPersistenceError>;
    readonly getById: (
      userId: AuthUserId,
    ) => Effect.Effect<Option.Option<AuthUser>, UserRegistryPersistenceError>;
    readonly getByIdentity: (
      identity: AuthUserIdentity,
    ) => Effect.Effect<Option.Option<AuthUser>, UserRegistryPersistenceError>;
    readonly list: () => Effect.Effect<ReadonlyArray<AuthUser>, UserRegistryPersistenceError>;
    /** pending -> active with a role. */
    readonly approve: (input: {
      readonly userId: AuthUserId;
      readonly role: AuthUserRole;
      readonly actor: AuthUserAccessActor;
    }) => Effect.Effect<
      AuthUser,
      AuthUserNotFoundError | AuthUserTransitionError | UserRegistryPersistenceError
    >;
    /** Changes the role of an active or disabled user. Refuses to demote the last active administrator. */
    readonly changeRole: (input: {
      readonly userId: AuthUserId;
      readonly role: AuthUserRole;
      readonly actor: AuthUserAccessActor;
    }) => Effect.Effect<
      AuthUser,
      | AuthUserNotFoundError
      | AuthUserTransitionError
      | LastAdministratorError
      | UserRegistryPersistenceError
    >;
    /** pending or active -> disabled, keeping the role. Refuses to disable the last active administrator. */
    readonly disable: (input: {
      readonly userId: AuthUserId;
      readonly actor: AuthUserAccessActor;
    }) => Effect.Effect<
      AuthUser,
      AuthUserNotFoundError | LastAdministratorError | UserRegistryPersistenceError
    >;
    /**
     * disabled -> active. Restores the kept role unless `role` overrides it;
     * a user disabled before approval has no role and needs one.
     */
    readonly enable: (input: {
      readonly userId: AuthUserId;
      readonly role?: AuthUserRole;
      readonly actor: AuthUserAccessActor;
    }) => Effect.Effect<
      AuthUser,
      | AuthUserNotFoundError
      | AuthUserTransitionError
      | AuthUserRoleRequiredError
      | UserRegistryPersistenceError
    >;
    /**
     * Host-local recovery path: makes the identity an active administrator,
     * creating the user if it has never signed in. Bypasses the
     * last-administrator guard because it only ever grants access. Only the
     * host CLI may call this.
     */
    readonly provisionAdministratorFromHost: (
      identity: AuthUserIdentity,
    ) => Effect.Effect<AuthUser, UserRegistryPersistenceError>;
    /** Newest first. */
    readonly listAccessChanges: (input?: {
      readonly userId?: AuthUserId;
    }) => Effect.Effect<ReadonlyArray<AuthUserAccessChange>, UserRegistryPersistenceError>;
    readonly streamAccessChanges: Stream.Stream<AuthUserAccessChanged>;
  }
>()("t3/auth/UserRegistry") {}

type AccessState = Pick<AuthUser, "status" | "role">;

const isActiveAdministrator = (state: AccessState) =>
  state.status === "active" && state.role === "administrator";

const persistenceError = (operation: string) => (cause: unknown) =>
  new UserRegistryPersistenceError({ operation, cause });

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const users = yield* AuthUsers.AuthUserRepository;
  const changesPubSub = yield* PubSub.unbounded<AuthUserAccessChanged>();

  const newUserId = crypto.randomUUIDv4.pipe(
    Effect.map(AuthUserId.make),
    Effect.mapError(persistenceError("generateUserId")),
  );

  const writeAccess = (
    current: AuthUser,
    next: AccessState,
    actor: AuthUserAccessActor,
    now: DateTime.Utc,
  ) =>
    Effect.gen(function* () {
      const user = yield* users.updateAccess({
        userId: current.userId,
        status: next.status,
        role: next.role,
        updatedAt: now,
      });
      const change = yield* users.appendAccessChange({
        userId: current.userId,
        actor,
        previousStatus: current.status,
        status: next.status,
        previousRole: current.role,
        role: next.role,
        changedAt: now,
      });
      return { user, change } satisfies AuthUserAccessChanged;
    });

  /**
   * Reads the user, lets `decide` pick the next access state (or `null` for a
   * no-op), and writes the change and its audit record in one transaction.
   * Publishes only after commit. Uninterruptible, so a change that commits
   * always reaches the live sockets that watch for it.
   */
  const transition = <E>(
    operation: string,
    userId: AuthUserId,
    actor: AuthUserAccessActor,
    decide: (user: AuthUser) => Effect.Effect<AccessState | null, E>,
  ) =>
    Effect.gen(function* () {
      const result = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* users
              .getById(userId)
              .pipe(Effect.mapError(persistenceError(operation)));
            if (Option.isNone(current)) {
              return yield* new AuthUserNotFoundError({ userId });
            }
            const next = yield* decide(current.value);
            if (next === null) {
              return { user: current.value, changed: null };
            }
            const changed = yield* writeAccess(
              current.value,
              next,
              actor,
              yield* DateTime.now,
            ).pipe(Effect.mapError(persistenceError(operation)));
            return { user: changed.user, changed };
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            SqlError.isSqlError(error) ? persistenceError(operation)(error) : error,
          ),
        );
      if (result.changed !== null) {
        yield* PubSub.publish(changesPubSub, result.changed);
      }
      return result.user;
    }).pipe(Effect.uninterruptible, Effect.withSpan(`UserRegistry.${operation}`));

  // Runs inside the transition's transaction, so the count and the write it
  // guards commit together.
  const requireAnotherActiveAdministrator = (user: AuthUser, next: AccessState) =>
    Effect.gen(function* () {
      if (!isActiveAdministrator(user) || isActiveAdministrator(next)) {
        return;
      }
      const administrators = yield* users
        .countActiveAdministrators()
        .pipe(Effect.mapError(persistenceError("countActiveAdministrators")));
      if (administrators <= 1) {
        return yield* new LastAdministratorError({ userId: user.userId });
      }
    });

  const recordSignIn: UserRegistry["Service"]["recordSignIn"] = (input) =>
    Effect.gen(function* () {
      const userId = yield* newUserId;
      return yield* users
        .recordSignIn({
          userId,
          tenantId: input.identity.tenantId,
          objectId: input.identity.objectId,
          email: input.email,
          displayName: input.displayName,
          now: yield* DateTime.now,
        })
        .pipe(Effect.mapError(persistenceError("recordSignIn")));
    }).pipe(Effect.withSpan("UserRegistry.recordSignIn"));

  const approve: UserRegistry["Service"]["approve"] = ({ userId, role, actor }) =>
    transition("approve", userId, actor, (user) =>
      Effect.gen(function* () {
        if (user.status !== "pending") {
          return yield* new AuthUserTransitionError({
            userId,
            operation: "approve",
            status: user.status,
          });
        }
        return { status: "active", role } satisfies AccessState;
      }),
    );

  const changeRole: UserRegistry["Service"]["changeRole"] = ({ userId, role, actor }) =>
    transition("changeRole", userId, actor, (user) =>
      Effect.gen(function* () {
        if (user.status === "pending") {
          return yield* new AuthUserTransitionError({
            userId,
            operation: "changeRole",
            status: user.status,
          });
        }
        if (user.role === role) {
          return null;
        }
        const next = { status: user.status, role } satisfies AccessState;
        yield* requireAnotherActiveAdministrator(user, next);
        return next;
      }),
    );

  const disable: UserRegistry["Service"]["disable"] = ({ userId, actor }) =>
    transition("disable", userId, actor, (user) =>
      Effect.gen(function* () {
        if (user.status === "disabled") {
          return null;
        }
        const next = { status: "disabled", role: user.role } satisfies AccessState;
        yield* requireAnotherActiveAdministrator(user, next);
        return next;
      }),
    );

  const enable: UserRegistry["Service"]["enable"] = ({ userId, role, actor }) =>
    transition("enable", userId, actor, (user) =>
      Effect.gen(function* () {
        if (user.status !== "disabled") {
          return yield* new AuthUserTransitionError({
            userId,
            operation: "enable",
            status: user.status,
          });
        }
        const nextRole = role ?? user.role;
        if (nextRole === null) {
          return yield* new AuthUserRoleRequiredError({ userId });
        }
        return { status: "active", role: nextRole } satisfies AccessState;
      }),
    );

  const provisionAdministratorFromHost: UserRegistry["Service"]["provisionAdministratorFromHost"] =
    (identity) =>
      Effect.gen(function* () {
        const actor = { type: "host-cli" } as const;
        const administrator = { status: "active", role: "administrator" } as const;
        const userId = yield* newUserId;
        const result = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              const existing = yield* users.getByIdentity(identity);
              if (Option.isSome(existing)) {
                if (isActiveAdministrator(existing.value)) {
                  return { user: existing.value, changed: null };
                }
                const changed = yield* writeAccess(existing.value, administrator, actor, now);
                return { user: changed.user, changed };
              }
              const user = yield* users.insert({
                userId,
                tenantId: identity.tenantId,
                objectId: identity.objectId,
                ...administrator,
                now,
              });
              const change = yield* users.appendAccessChange({
                userId,
                actor,
                previousStatus: null,
                status: user.status,
                previousRole: null,
                role: user.role,
                changedAt: now,
              });
              return { user, changed: { user, change } };
            }),
          )
          .pipe(Effect.mapError(persistenceError("provisionAdministratorFromHost")));
        if (result.changed !== null) {
          yield* PubSub.publish(changesPubSub, result.changed);
        }
        return result.user;
      }).pipe(
        Effect.uninterruptible,
        Effect.withSpan("UserRegistry.provisionAdministratorFromHost"),
      );

  return UserRegistry.of({
    recordSignIn,
    getById: (userId) => users.getById(userId).pipe(Effect.mapError(persistenceError("getById"))),
    getByIdentity: (identity) =>
      users.getByIdentity(identity).pipe(Effect.mapError(persistenceError("getByIdentity"))),
    list: () => users.list().pipe(Effect.mapError(persistenceError("list"))),
    approve,
    changeRole,
    disable,
    enable,
    provisionAdministratorFromHost,
    listAccessChanges: (input) =>
      users
        .listAccessChanges(input?.userId === undefined ? {} : { userId: input.userId })
        .pipe(Effect.mapError(persistenceError("listAccessChanges"))),
    get streamAccessChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  });
});

export const layer = Layer.effect(UserRegistry, make).pipe(Layer.provideMerge(AuthUsers.layer));
