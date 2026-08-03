import { describe, expect, it, vi } from "vite-plus/test";

import { makeReadinessCoordinator } from "./readiness.ts";

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("Slack readiness coordination", () => {
  it("cannot commit a delayed success after Slack disconnects", async () => {
    const pending = deferred<string>();
    const onReady = vi.fn();
    const onUnavailable = vi.fn();
    const coordinator = makeReadinessCoordinator({
      check: () => pending.promise,
      isShuttingDown: () => false,
      onReady,
      onFailure: vi.fn(),
      onUnavailable,
    });
    coordinator.setConnected(true);
    const checking = coordinator.run();

    coordinator.setConnected(false, "Slack Socket Mode is disconnected");
    pending.resolve("ready");
    await checking;

    expect(onReady).not.toHaveBeenCalled();
    expect(onUnavailable).toHaveBeenCalledWith("Slack Socket Mode is disconnected");
  });

  it("cannot let a stale failure overwrite a newer recovered check", async () => {
    const first = deferred<string>();
    const onReady = vi.fn();
    const onFailure = vi.fn();
    const check = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce("new");
    const coordinator = makeReadinessCoordinator({
      check,
      isShuttingDown: () => false,
      onReady,
      onFailure,
      onUnavailable: vi.fn(),
    });
    coordinator.setConnected(true);
    const stale = coordinator.run();
    await coordinator.run();
    first.reject(new Error("old failure"));
    await stale;

    expect(onReady).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledWith("new");
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("invalidates an old generation across disconnect and reconnect", async () => {
    const first = deferred<string>();
    const onReady = vi.fn();
    const check = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce("new");
    const coordinator = makeReadinessCoordinator({
      check,
      isShuttingDown: () => false,
      onReady,
      onFailure: vi.fn(),
      onUnavailable: vi.fn(),
    });
    coordinator.setConnected(true);
    const stale = coordinator.run();
    coordinator.setConnected(false);
    coordinator.setConnected(true);
    await coordinator.run();
    first.resolve("old");
    await stale;

    expect(onReady).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledWith("new");
  });
});
