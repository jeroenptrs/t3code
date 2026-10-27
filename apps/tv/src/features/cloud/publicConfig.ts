import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import Constants from "expo-constants";

// Reads the same `extra.clerk` and `extra.relay` values apps/mobile reads, so a
// repository-root `.env` configures both apps identically.

export interface CloudPublicConfig {
  readonly clerk: {
    readonly publishableKey: string | null;
    readonly jwtTemplate: string | null;
  };
  readonly relay: {
    readonly url: string | null;
  };
}

type ExpoExtra =
  | {
      readonly clerk?: { readonly publishableKey?: unknown; readonly jwtTemplate?: unknown };
      readonly relay?: { readonly url?: unknown };
    }
  | undefined;

function trimNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveCloudPublicConfig(
  extra: ExpoExtra = Constants.expoConfig?.extra as ExpoExtra,
): CloudPublicConfig {
  return {
    clerk: {
      publishableKey: trimNonEmpty(extra?.clerk?.publishableKey),
      jwtTemplate: trimNonEmpty(extra?.clerk?.jwtTemplate),
    },
    relay: {
      url: normalizeSecureRelayUrl(trimNonEmpty(extra?.relay?.url) ?? ""),
    },
  };
}

export function hasCloudPublicConfig(config = resolveCloudPublicConfig()): boolean {
  return Boolean(config.clerk.publishableKey && config.clerk.jwtTemplate && config.relay.url);
}
