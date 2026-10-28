import { AuthOrchestrationOperateScope, type AuthSessionState } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { awaitSessionScope, sessionResultGrants } from "./sessionScope";

const session = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});

function loadingSession() {
  const registry = AtomRegistry.make();
  const atom = Atom.make<AsyncResult.AsyncResult<AuthSessionState, unknown>>(
    AsyncResult.initial(true),
  );
  const unmount = registry.mount(atom);
  return {
    registry,
    atom,
    [Symbol.dispose]: () => {
      unmount();
      registry.dispose();
    },
  };
}

describe("awaitSessionScope", () => {
  it("waits for a loading session that grants the scope", async () => {
    using fixture = loadingSession();
    expect(
      sessionResultGrants(fixture.registry.get(fixture.atom), AuthOrchestrationOperateScope),
    ).toBe(false);

    const granted = awaitSessionScope(
      fixture.registry,
      fixture.atom,
      AuthOrchestrationOperateScope,
    );
    fixture.registry.set(fixture.atom, AsyncResult.success(session(true)));

    expect(await granted).toBe(true);
  });

  it("denies once the loaded session lacks the scope", async () => {
    using fixture = loadingSession();

    const granted = awaitSessionScope(
      fixture.registry,
      fixture.atom,
      AuthOrchestrationOperateScope,
    );
    fixture.registry.set(fixture.atom, AsyncResult.success(session(false)));

    expect(await granted).toBe(false);
  });
});
