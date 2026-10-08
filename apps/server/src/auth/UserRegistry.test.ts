import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { AuthUserIdentity } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as UserRegistry from "./UserRegistry.ts";

const TENANT = "8f2c3a1e-1b2c-4d5e-8f90-123456789abc";
const identity = (suffix: string): AuthUserIdentity => ({
  tenantId: TENANT,
  objectId: `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
});

const hostCli = { type: "host-cli" } as const;

const makeLayer = () => UserRegistry.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const signIn = (suffix: string, labels?: { email?: string; displayName?: string }) =>
  Effect.gen(function* () {
    const registry = yield* UserRegistry.UserRegistry;
    return yield* registry.recordSignIn({
      identity: identity(suffix),
      email: labels?.email ?? null,
      displayName: labels?.displayName ?? null,
    });
  });

it.layer(NodeServices.layer)("UserRegistry", (it) => {
  it.effect(
    "creates a pending user without a role on first sign-in, then finds the same user",
    () =>
      Effect.gen(function* () {
        const registry = yield* UserRegistry.UserRegistry;
        const first = yield* signIn("1", { email: "ada@example.com", displayName: "Ada" });
        const again = yield* signIn("1", { email: "ada@example.com", displayName: "Ada" });

        expect(first.status).toBe("pending");
        expect(first.role).toBeNull();
        expect(again.userId).toBe(first.userId);
        expect(Option.isSome(yield* registry.getByIdentity(identity("1")))).toBe(true);
        expect(yield* registry.list()).toHaveLength(1);
        expect(yield* registry.listAccessChanges()).toEqual([]);
      }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refreshing labels on a later sign-in leaves status and role alone", () =>
    Effect.gen(function* () {
      const registry = yield* UserRegistry.UserRegistry;
      const pending = yield* signIn("1", { email: "old@example.com", displayName: "Old" });
      yield* registry.approve({ userId: pending.userId, role: "operator", actor: hostCli });
      yield* registry.disable({ userId: pending.userId, actor: hostCli });

      const refreshed = yield* signIn("1", { email: "new@example.com", displayName: "New" });

      expect(refreshed).toMatchObject({
        userId: pending.userId,
        status: "disabled",
        role: "operator",
        email: "new@example.com",
        displayName: "New",
      });
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("approves, changes role, disables and re-enables with an audit trail", () =>
    Effect.gen(function* () {
      const registry = yield* UserRegistry.UserRegistry;
      const admin = yield* registry.provisionAdministratorFromHost(identity("a"));
      const actor = { type: "user", userId: admin.userId } as const;
      const pending = yield* signIn("1");
      const userId = pending.userId;

      expect(yield* registry.approve({ userId, role: "reader", actor })).toMatchObject({
        status: "active",
        role: "reader",
      });
      expect(yield* registry.changeRole({ userId, role: "operator", actor })).toMatchObject({
        status: "active",
        role: "operator",
      });
      expect(yield* registry.disable({ userId, actor })).toMatchObject({
        status: "disabled",
        role: "operator",
      });
      expect(yield* registry.enable({ userId, actor })).toMatchObject({
        status: "active",
        role: "operator",
      });

      const changes = yield* registry.listAccessChanges({ userId });
      expect(
        changes.map((change) => [
          change.previousStatus,
          change.status,
          change.previousRole,
          change.role,
        ]),
      ).toEqual([
        ["disabled", "active", "operator", "operator"],
        ["active", "disabled", "operator", "operator"],
        ["active", "active", "reader", "operator"],
        ["pending", "active", null, "reader"],
      ]);
      expect(changes.every((change) => change.actor.type === "user")).toBe(true);
      expect(changes[0]?.actor).toEqual(actor);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("rejects transitions that do not apply and treats repeats as no-ops", () =>
    Effect.gen(function* () {
      const registry = yield* UserRegistry.UserRegistry;
      const pending = yield* signIn("1");
      const userId = pending.userId;

      const changeRolePending = yield* registry
        .changeRole({ userId, role: "reader", actor: hostCli })
        .pipe(Effect.flip);
      const enablePending = yield* registry.enable({ userId, actor: hostCli }).pipe(Effect.flip);
      expect(changeRolePending._tag).toBe("AuthUserTransitionError");
      expect(enablePending._tag).toBe("AuthUserTransitionError");

      // Rejecting a request disables a user who never had a role; enabling needs one.
      yield* registry.disable({ userId, actor: hostCli });
      const roleRequired = yield* registry.enable({ userId, actor: hostCli }).pipe(Effect.flip);
      expect(roleRequired._tag).toBe("AuthUserRoleRequiredError");
      const approveDisabled = yield* registry
        .approve({ userId, role: "reader", actor: hostCli })
        .pipe(Effect.flip);
      expect(approveDisabled._tag).toBe("AuthUserTransitionError");

      yield* registry.enable({ userId, role: "reader", actor: hostCli });
      yield* registry.changeRole({ userId, role: "reader", actor: hostCli });
      const before = (yield* registry.listAccessChanges({ userId })).length;
      yield* registry.changeRole({ userId, role: "reader", actor: hostCli });
      expect(yield* registry.listAccessChanges({ userId })).toHaveLength(before);

      const missing = yield* registry
        .disable({ userId: "missing" as typeof userId, actor: hostCli })
        .pipe(Effect.flip);
      expect(missing._tag).toBe("AuthUserNotFoundError");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses to disable or demote the last active administrator", () =>
    Effect.gen(function* () {
      const registry = yield* UserRegistry.UserRegistry;
      const first = yield* registry.provisionAdministratorFromHost(identity("a"));

      const disableLast = yield* registry
        .disable({ userId: first.userId, actor: hostCli })
        .pipe(Effect.flip);
      const demoteLast = yield* registry
        .changeRole({ userId: first.userId, role: "operator", actor: hostCli })
        .pipe(Effect.flip);
      expect(disableLast._tag).toBe("LastAdministratorError");
      expect(demoteLast._tag).toBe("LastAdministratorError");
      expect(yield* registry.listAccessChanges({ userId: first.userId })).toHaveLength(1);

      // A disabled administrator does not count, so it cannot stand in for the last active one.
      const second = yield* signIn("b");
      yield* registry.approve({ userId: second.userId, role: "administrator", actor: hostCli });
      yield* registry.disable({ userId: second.userId, actor: hostCli });
      const stillLast = yield* registry
        .disable({ userId: first.userId, actor: hostCli })
        .pipe(Effect.flip);
      expect(stillLast._tag).toBe("LastAdministratorError");

      yield* registry.enable({ userId: second.userId, actor: hostCli });
      expect(
        yield* registry.changeRole({ userId: first.userId, role: "reader", actor: hostCli }),
      ).toMatchObject({ status: "active", role: "reader" });
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("host provisioning creates, re-enables and promotes administrators", () =>
    Effect.gen(function* () {
      const registry = yield* UserRegistry.UserRegistry;

      const created = yield* registry.provisionAdministratorFromHost(identity("a"));
      expect(created).toMatchObject({
        status: "active",
        role: "administrator",
        lastSignInAt: null,
      });
      const firstSignIn = yield* signIn("a", { displayName: "Grace" });
      expect(firstSignIn).toMatchObject({
        userId: created.userId,
        status: "active",
        role: "administrator",
        displayName: "Grace",
      });

      const operator = yield* signIn("b");
      yield* registry.approve({ userId: operator.userId, role: "operator", actor: hostCli });
      yield* registry.disable({ userId: operator.userId, actor: hostCli });
      const promoted = yield* registry.provisionAdministratorFromHost(identity("b"));
      expect(promoted).toMatchObject({
        userId: operator.userId,
        status: "active",
        role: "administrator",
      });

      // Already an active administrator: nothing to audit.
      yield* registry.provisionAdministratorFromHost(identity("a"));
      const createdChanges = yield* registry.listAccessChanges({ userId: created.userId });
      expect(createdChanges).toHaveLength(1);
      expect(createdChanges[0]).toMatchObject({
        actor: hostCli,
        previousStatus: null,
        status: "active",
        previousRole: null,
        role: "administrator",
      });
      expect((yield* registry.listAccessChanges({ userId: operator.userId }))[0]).toMatchObject({
        actor: hostCli,
        previousStatus: "disabled",
        previousRole: "operator",
        status: "active",
        role: "administrator",
      });
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("publishes access changes after commit, but not label refreshes or no-ops", () =>
    Effect.gen(function* () {
      const registry = yield* UserRegistry.UserRegistry;
      const changes = yield* Queue.unbounded<UserRegistry.AuthUserAccessChanged>();
      yield* registry.streamAccessChanges.pipe(
        Stream.runForEach((change) => Queue.offer(changes, change)),
        Effect.forkScoped({ startImmediately: true }),
      );

      const admin = yield* registry.provisionAdministratorFromHost(identity("a"));
      expect((yield* Queue.take(changes)).user.userId).toBe(admin.userId);

      const pending = yield* signIn("1");
      yield* signIn("1", { email: "label@example.com" });
      yield* registry.disable({ userId: admin.userId, actor: hostCli }).pipe(Effect.flip);
      yield* registry.approve({ userId: pending.userId, role: "reader", actor: hostCli });
      yield* registry.changeRole({ userId: pending.userId, role: "reader", actor: hostCli });
      yield* registry.disable({ userId: pending.userId, actor: hostCli });

      const approved = yield* Queue.take(changes);
      expect(approved.user).toMatchObject({ userId: pending.userId, status: "active" });
      expect(approved.change).toMatchObject({ previousStatus: "pending", role: "reader" });
      const disabled = yield* Queue.take(changes);
      expect(disabled.user).toMatchObject({ userId: pending.userId, status: "disabled" });
      expect(yield* Queue.size(changes)).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(makeLayer())),
  );
});
