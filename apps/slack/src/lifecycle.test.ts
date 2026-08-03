import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { makeSlackDaemonLifecycle } from "./lifecycle.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("Slack daemon lifecycle", () => {
  it("cleans up a failed Slack start before scheduling a reconnect", async () => {
    vi.useFakeTimers();
    const startSlack = vi.fn().mockRejectedValueOnce(new Error("partial startup"));
    const stopSlack = vi.fn(async () => undefined);
    const onStartFailure = vi.fn();
    const lifecycle = makeSlackDaemonLifecycle({
      startSlack,
      stopSlack,
      startAppHome: vi.fn(),
      stopAppHome: vi.fn(async () => undefined),
      refreshReadiness: vi.fn(async () => undefined),
      closeTransport: vi.fn(async () => undefined),
      closeHealth: vi.fn(async () => undefined),
      onStartFailure,
      reconnectDelayMs: 5_000,
    });

    await lifecycle.start();

    expect(stopSlack).toHaveBeenCalledOnce();
    expect(onStartFailure).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    await lifecycle.shutdown();
  });

  it("does not start App Home or timers when shutdown begins during Slack startup", async () => {
    vi.useFakeTimers();
    let resolveStart!: () => void;
    const startSlack = vi.fn(() => new Promise<void>((resolve) => (resolveStart = resolve)));
    const stopSlack = vi.fn(async () => undefined);
    const startAppHome = vi.fn();
    const stopAppHome = vi.fn(async () => undefined);
    const refreshReadiness = vi.fn(async () => undefined);
    const closeTransport = vi.fn(async () => undefined);
    const closeHealth = vi.fn(async () => undefined);
    const lifecycle = makeSlackDaemonLifecycle({
      startSlack,
      stopSlack,
      startAppHome,
      stopAppHome,
      refreshReadiness,
      closeTransport,
      closeHealth,
      onStartFailure: vi.fn(),
    });

    const starting = lifecycle.start();
    await vi.waitFor(() => expect(startSlack).toHaveBeenCalledOnce());
    const stopping = lifecycle.shutdown();
    await vi.waitFor(() => expect(closeTransport).toHaveBeenCalledOnce());
    resolveStart();
    await Promise.all([starting, stopping]);

    expect(startAppHome).not.toHaveBeenCalled();
    expect(refreshReadiness).not.toHaveBeenCalled();
    expect(stopSlack.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(closeHealth).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tracks an active readiness check and cannot install its interval after shutdown", async () => {
    vi.useFakeTimers();
    let resolveReadiness!: () => void;
    const refreshReadiness = vi.fn(
      () => new Promise<void>((resolve) => (resolveReadiness = resolve)),
    );
    const stopSlack = vi.fn(async () => undefined);
    const closeTransport = vi.fn(async () => undefined);
    const closeHealth = vi.fn(async () => undefined);
    const lifecycle = makeSlackDaemonLifecycle({
      startSlack: vi.fn(async () => undefined),
      stopSlack,
      startAppHome: vi.fn(),
      stopAppHome: vi.fn(async () => undefined),
      refreshReadiness,
      closeTransport,
      closeHealth,
      onStartFailure: vi.fn(),
    });

    const starting = lifecycle.start();
    await vi.waitFor(() => expect(refreshReadiness).toHaveBeenCalledOnce());
    const stopping = lifecycle.shutdown();
    resolveReadiness();
    await Promise.all([starting, stopping]);

    expect(stopSlack.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(closeTransport.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(closeHealth).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
