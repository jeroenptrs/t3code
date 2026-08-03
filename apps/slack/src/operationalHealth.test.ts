import { describe, expect, it, vi } from "vite-plus/test";

import { makeOperationalHealth } from "./operationalHealth.ts";
import { hasExactScopes } from "./scopes.ts";

describe("Slack operational health", () => {
  it("accepts only the exact daemon scope set", () => {
    const required = ["orchestration:read", "orchestration:operate"];
    expect(hasExactScopes(required, required)).toBe(true);
    expect(hasExactScopes(required.toReversed(), required)).toBe(true);
    expect(hasExactScopes([required[0]!], required)).toBe(false);
    expect(hasExactScopes([...required, "terminal:operate"], required)).toBe(false);
    expect(hasExactScopes([...required, required[1]!], required)).toBe(false);
  });

  it("logs a changed failure category even when the public reason is unchanged", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const health = makeOperationalHealth({
      initial: { live: true, ready: false, reason: "starting" },
      logger,
      credentialExpiryWarningDays: 10,
    });
    const state = { live: true, ready: false, reason: "T3 readiness check failed" };

    health.update(state, { category: "authentication" });
    health.update(state, { category: "missing_project" });
    health.update(state, { category: "missing_project" });

    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("logs readiness only when the state changes", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const health = makeOperationalHealth({
      initial: { live: true, ready: false, reason: "starting" },
      logger,
      credentialExpiryWarningDays: 10,
    });

    health.update(
      { live: true, ready: false, reason: "T3 readiness check failed" },
      {
        category: "authentication",
      },
    );
    health.update(
      { live: true, ready: false, reason: "T3 readiness check failed" },
      {
        category: "authentication",
      },
    );
    health.update({ live: true, ready: true, reason: null });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("slack.health.changed", {
      live: true,
      ready: false,
      reason: "T3 readiness check failed",
      category: "authentication",
    });
  });

  it("does not clear a failure category when observing credential expiry", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const health = makeOperationalHealth({
      initial: { live: true, ready: false, reason: "starting" },
      logger,
      credentialExpiryWarningDays: 10,
      now: () => Date.parse("2026-08-02T00:00:00.000Z"),
    });
    const failed = { live: true, ready: false, reason: "T3 readiness check failed" };

    health.update(failed, { category: "authentication" });
    health.observeCredentialExpiry("2026-08-20T00:00:00.000Z");
    health.update(failed, { category: "authentication" });

    expect(
      logger.warn.mock.calls.filter(([event]) => event === "slack.health.changed"),
    ).toHaveLength(1);
  });

  it("warns once when a credential enters the expiry window", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const now = Date.parse("2026-08-02T00:00:00.000Z");
    const health = makeOperationalHealth({
      initial: { live: true, ready: false, reason: "starting" },
      logger,
      credentialExpiryWarningDays: 10,
      now: () => now,
    });
    health.observeCredentialExpiry("2026-08-20T00:00:00.000Z");
    expect(logger.warn).not.toHaveBeenCalled();
    health.observeCredentialExpiry("2026-08-10T12:00:00.000Z");
    health.observeCredentialExpiry("2026-08-10T12:00:00.000Z");

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith("slack.credential.expiry-warning", {
      expiresAt: "2026-08-10T12:00:00.000Z",
      daysRemaining: 8,
    });
  });
});
