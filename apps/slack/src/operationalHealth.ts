import type { HealthState } from "./health.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface OperationalLogger {
  readonly info: (message: string, fields?: Record<string, unknown>) => void;
  readonly warn: (message: string, fields?: Record<string, unknown>) => void;
}

export interface OperationalHealth {
  readonly state: () => HealthState;
  readonly update: (
    next: HealthState,
    details?: {
      readonly category?: string;
    },
  ) => void;
  readonly observeCredentialExpiry: (expiresAt: string) => void;
}

export function makeOperationalHealth(input: {
  readonly initial: HealthState;
  readonly logger: OperationalLogger;
  readonly credentialExpiryWarningDays: number;
  readonly now?: () => number;
}): OperationalHealth {
  const now = input.now ?? Date.now;
  let current = input.initial;
  let currentCategory: string | null = null;
  let credentialWarningKey: string | null = null;

  const update: OperationalHealth["update"] = (next, details) => {
    if (
      next.live !== current.live ||
      next.ready !== current.ready ||
      next.reason !== current.reason ||
      (next.ready === false && (details?.category ?? null) !== currentCategory)
    ) {
      const fields = {
        live: next.live,
        ready: next.ready,
        reason: next.reason,
        ...(details?.category ? { category: details.category } : {}),
      };
      if (next.ready || !next.live || next.reason === "starting") {
        input.logger.info("slack.health.changed", fields);
      } else {
        input.logger.warn("slack.health.changed", fields);
      }
      current = next;
      currentCategory = next.ready ? null : (details?.category ?? null);
    }
  };

  const observeCredentialExpiry = (expiresAt: string): void => {
    const expiresAtMillis = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMillis)) return;
    const remainingMillis = expiresAtMillis - now();
    const warningMillis = input.credentialExpiryWarningDays * DAY_MS;
    const nextWarningKey = remainingMillis <= warningMillis ? expiresAt : null;
    if (nextWarningKey === null) {
      credentialWarningKey = null;
      return;
    }
    if (credentialWarningKey === nextWarningKey) return;
    credentialWarningKey = nextWarningKey;
    input.logger.warn("slack.credential.expiry-warning", {
      expiresAt,
      daysRemaining: Math.max(0, Math.floor(remainingMillis / DAY_MS)),
    });
  };

  return { state: () => current, update, observeCredentialExpiry };
}
